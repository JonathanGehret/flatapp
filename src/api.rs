//! JSON API. A flat is identified by its secret invite code, sent as the
//! `X-Flat-Code` header. Every mutation returns the flat's full state, so
//! clients never have to merge partial updates.

use std::sync::{Arc, Mutex};

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use chrono::{Days, Utc};
use rand::Rng;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::schedule::{next_due, next_in_rotation, parse_date, DATE_FMT};

pub type Shared = Arc<Mutex<Connection>>;
type ApiResult = Result<Json<Value>, ApiError>;

const COLORS: [&str; 8] = [
    "#0d9488", "#e11d48", "#7c3aed", "#ea580c", "#2563eb", "#65a30d", "#c026d3", "#ca8a04",
];
/// No 0/O, 1/I/L: codes get read aloud and typed on phones.
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN: usize = 10;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS flats (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY,
    flat_id INTEGER NOT NULL REFERENCES flats(id),
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS chores (
    id INTEGER PRIMARY KEY,
    flat_id INTEGER NOT NULL REFERENCES flats(id),
    title TEXT NOT NULL,
    icon TEXT NOT NULL,
    interval_n INTEGER NOT NULL,
    interval_unit TEXT NOT NULL,          -- day | week | month
    points INTEGER NOT NULL,              -- effort, 1..3
    assign_mode TEXT NOT NULL,            -- all | custom | anyone
    rotation TEXT NOT NULL,               -- JSON array of member ids, in turn order
    assignee_id INTEGER,                  -- whose turn it is; NULL = anyone
    next_due TEXT NOT NULL,               -- YYYY-MM-DD
    archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS completions (
    id INTEGER PRIMARY KEY,
    flat_id INTEGER NOT NULL REFERENCES flats(id),
    chore_id INTEGER NOT NULL REFERENCES chores(id),
    member_id INTEGER NOT NULL REFERENCES members(id),
    kind TEXT NOT NULL,                   -- done | skip
    date TEXT NOT NULL,                   -- YYYY-MM-DD, the client's local day
    points INTEGER NOT NULL,
    prev_due TEXT NOT NULL,               -- chore state before this entry, for undo
    prev_assignee INTEGER
);
CREATE TABLE IF NOT EXISTS rewards (
    flat_id INTEGER NOT NULL REFERENCES flats(id),
    month TEXT NOT NULL,                  -- YYYY-MM
    text TEXT NOT NULL,                   -- empty = explicitly no prize
    PRIMARY KEY (flat_id, month)
);
CREATE INDEX IF NOT EXISTS idx_members_flat ON members(flat_id);
CREATE INDEX IF NOT EXISTS idx_chores_flat ON chores(flat_id);
CREATE INDEX IF NOT EXISTS idx_completions_flat ON completions(flat_id, id);
CREATE INDEX IF NOT EXISTS idx_completions_chore ON completions(chore_id, id);
";

pub fn open(path: &str) -> rusqlite::Result<Shared> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.execute_batch(SCHEMA)?;
    Ok(Arc::new(Mutex::new(conn)))
}

pub fn router(state: Shared) -> Router {
    Router::new()
        .route("/flats", post(create_flat))
        .route("/state", get(get_state))
        .route("/flat", put(update_flat))
        .route("/reward", put(set_reward))
        .route("/members", post(add_member))
        .route("/members/{id}", put(rename_member).delete(remove_member))
        .route("/chores", post(create_chore))
        .route("/chores/{id}", put(update_chore).delete(archive_chore))
        .route("/chores/{id}/complete", post(complete_chore))
        .route("/chores/{id}/skip", post(skip_chore))
        .route("/completions/{id}", delete(undo_completion))
        .with_state(state)
}

// ---------- errors ----------

pub enum ApiError {
    BadRequest(&'static str),
    Unauthorized,
    NotFound,
    Internal(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.to_string()),
            ApiError::Unauthorized => (StatusCode::UNAUTHORIZED, "Unknown flat code".into()),
            ApiError::NotFound => (StatusCode::NOT_FOUND, "Not found".into()),
            ApiError::Internal(e) => {
                eprintln!("internal error: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, "Server error".into())
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(e: rusqlite::Error) -> Self {
        ApiError::Internal(e.to_string())
    }
}

// ---------- helpers ----------

fn normalize_code(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

fn auth(c: &Connection, headers: &HeaderMap) -> Result<i64, ApiError> {
    let code = headers
        .get("x-flat-code")
        .and_then(|v| v.to_str().ok())
        .map(normalize_code)
        .ok_or(ApiError::Unauthorized)?;
    c.query_row("SELECT id FROM flats WHERE code = ?1", [code], |r| r.get(0))
        .optional()?
        .ok_or(ApiError::Unauthorized)
}

fn clean_name(raw: &str, max: usize) -> Result<String, ApiError> {
    let name = raw.trim();
    if name.is_empty() || name.chars().count() > max {
        return Err(ApiError::BadRequest("Name must be 1 to 40 characters"));
    }
    Ok(name.to_string())
}

fn active_members(c: &Connection, flat: i64) -> rusqlite::Result<Vec<i64>> {
    c.prepare("SELECT id FROM members WHERE flat_id = ?1 AND active = 1 ORDER BY id")?
        .query_map([flat], |r| r.get(0))?
        .collect()
}

fn require_member(c: &Connection, flat: i64, id: i64) -> Result<(), ApiError> {
    let found: Option<i64> = c
        .query_row(
            "SELECT id FROM members WHERE id = ?1 AND flat_id = ?2 AND active = 1",
            [id, flat],
            |r| r.get(0),
        )
        .optional()?;
    found.map(|_| ()).ok_or(ApiError::BadRequest("Unknown member"))
}

fn insert_member(c: &Connection, flat: i64, name: &str) -> Result<i64, ApiError> {
    let taken: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM members
         WHERE flat_id = ?1 AND active = 1 AND lower(name) = lower(?2))",
        params![flat, name],
        |r| r.get(0),
    )?;
    if taken {
        return Err(ApiError::BadRequest("Someone with that name is already in the flat"));
    }
    let count: i64 =
        c.query_row("SELECT COUNT(*) FROM members WHERE flat_id = ?1", [flat], |r| r.get(0))?;
    c.execute(
        "INSERT INTO members (flat_id, name, color) VALUES (?1, ?2, ?3)",
        params![flat, name, COLORS[count as usize % COLORS.len()]],
    )?;
    Ok(c.last_insert_rowid())
}

fn rotation_json(rotation: &[i64]) -> String {
    serde_json::to_string(rotation).unwrap_or_else(|_| "[]".into())
}

/// The member in `rotation` who currently has the fewest chores waiting.
fn least_loaded(c: &Connection, flat: i64, rotation: &[i64]) -> rusqlite::Result<Option<i64>> {
    let mut best: Option<(i64, i64)> = None;
    for &m in rotation {
        let load: i64 = c.query_row(
            "SELECT COUNT(*) FROM chores WHERE flat_id = ?1 AND archived = 0 AND assignee_id = ?2",
            [flat, m],
            |r| r.get(0),
        )?;
        if best.is_none_or(|(_, l)| load < l) {
            best = Some((m, load));
        }
    }
    Ok(best.map(|(m, _)| m))
}

/// Keep "everyone takes turns" chores in line with the current member list.
/// With `rebalance`, chores nobody has done yet are dealt out evenly, so a
/// flat that was just set up does not start with everything on one person.
fn sync_rotations(c: &Connection, flat: i64, rebalance: bool) -> rusqlite::Result<()> {
    let members = active_members(c, flat)?;
    let chores: Vec<(i64, Option<i64>, i64)> = c
        .prepare(
            "SELECT id, assignee_id,
                    (SELECT COUNT(*) FROM completions WHERE chore_id = chores.id)
             FROM chores WHERE flat_id = ?1 AND archived = 0 AND assign_mode = 'all'
             ORDER BY id",
        )?
        .query_map([flat], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (i, (id, assignee, history)) in chores.into_iter().enumerate() {
        let assignee = if members.is_empty() {
            None
        } else if rebalance && history == 0 {
            Some(members[i % members.len()])
        } else if assignee.is_some_and(|a| members.contains(&a)) {
            assignee
        } else {
            Some(members[0])
        };
        c.execute(
            "UPDATE chores SET rotation = ?1, assignee_id = ?2 WHERE id = ?3",
            params![rotation_json(&members), assignee, id],
        )?;
    }
    Ok(())
}

struct ChoreRow {
    interval_n: u32,
    interval_unit: String,
    points: i64,
    rotation: Vec<i64>,
    assignee_id: Option<i64>,
    next_due: String,
}

fn get_chore(c: &Connection, flat: i64, id: i64) -> Result<ChoreRow, ApiError> {
    c.query_row(
        "SELECT interval_n, interval_unit, points, rotation, assignee_id, next_due
         FROM chores WHERE id = ?1 AND flat_id = ?2 AND archived = 0",
        [id, flat],
        |r| {
            let rotation: String = r.get(3)?;
            Ok(ChoreRow {
                interval_n: r.get(0)?,
                interval_unit: r.get(1)?,
                points: r.get(2)?,
                rotation: serde_json::from_str(&rotation).unwrap_or_default(),
                assignee_id: r.get(4)?,
                next_due: r.get(5)?,
            })
        },
    )
    .optional()?
    .ok_or(ApiError::NotFound)
}

fn load_state(c: &Connection, flat: i64) -> Result<Json<Value>, ApiError> {
    let flat_json = c.query_row("SELECT name, code FROM flats WHERE id = ?1", [flat], |r| {
        Ok(json!({ "name": r.get::<_, String>(0)?, "code": r.get::<_, String>(1)? }))
    })?;

    let members: Vec<Value> = c
        .prepare("SELECT id, name, color, active FROM members WHERE flat_id = ?1 ORDER BY id")?
        .query_map([flat], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "name": r.get::<_, String>(1)?,
                "color": r.get::<_, String>(2)?,
                "active": r.get::<_, bool>(3)?,
            }))
        })?
        .collect::<rusqlite::Result<_>>()?;

    let chores: Vec<Value> = c
        .prepare(
            "SELECT id, title, icon, interval_n, interval_unit, points, assign_mode,
                    rotation, assignee_id, next_due
             FROM chores WHERE flat_id = ?1 AND archived = 0 ORDER BY next_due, id",
        )?
        .query_map([flat], |r| {
            let rotation: String = r.get(7)?;
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "title": r.get::<_, String>(1)?,
                "icon": r.get::<_, String>(2)?,
                "interval_n": r.get::<_, i64>(3)?,
                "interval_unit": r.get::<_, String>(4)?,
                "points": r.get::<_, i64>(5)?,
                "assign_mode": r.get::<_, String>(6)?,
                "rotation": serde_json::from_str::<Value>(&rotation).unwrap_or(json!([])),
                "assignee_id": r.get::<_, Option<i64>>(8)?,
                "next_due": r.get::<_, String>(9)?,
            }))
        })?
        .collect::<rusqlite::Result<_>>()?;

    // Only the newest entry of a chore can be undone: older ones no longer
    // describe the chore's previous state.
    let activity: Vec<Value> = c
        .prepare(
            "SELECT co.id, co.chore_id, ch.title, ch.icon, co.member_id, co.kind, co.date,
                    co.points,
                    ch.archived = 0 AND co.id =
                        (SELECT MAX(id) FROM completions WHERE chore_id = co.chore_id)
             FROM completions co JOIN chores ch ON ch.id = co.chore_id
             WHERE co.flat_id = ?1 ORDER BY co.id DESC LIMIT 60",
        )?
        .query_map([flat], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "chore_id": r.get::<_, i64>(1)?,
                "title": r.get::<_, String>(2)?,
                "icon": r.get::<_, String>(3)?,
                "member_id": r.get::<_, i64>(4)?,
                "kind": r.get::<_, String>(5)?,
                "date": r.get::<_, String>(6)?,
                "points": r.get::<_, i64>(7)?,
                "undoable": r.get::<_, bool>(8)?,
            }))
        })?
        .collect::<rusqlite::Result<_>>()?;

    // Points per calendar month for the past year. The client decides which
    // month is "this month" from its own clock.
    let since = (Utc::now().date_naive() - Days::new(400)).format(DATE_FMT).to_string();
    let scores: Vec<Value> = c
        .prepare(
            "SELECT substr(date, 1, 7) AS month, member_id, SUM(points), COUNT(*)
             FROM completions
             WHERE flat_id = ?1 AND kind = 'done' AND date >= ?2
             GROUP BY month, member_id ORDER BY month DESC",
        )?
        .query_map(params![flat, since], |r| {
            Ok(json!({
                "month": r.get::<_, String>(0)?,
                "member_id": r.get::<_, i64>(1)?,
                "points": r.get::<_, i64>(2)?,
                "count": r.get::<_, i64>(3)?,
            }))
        })?
        .collect::<rusqlite::Result<_>>()?;

    let rewards: Vec<Value> = c
        .prepare("SELECT month, text FROM rewards WHERE flat_id = ?1 ORDER BY month DESC LIMIT 36")?
        .query_map([flat], |r| {
            Ok(json!({ "month": r.get::<_, String>(0)?, "text": r.get::<_, String>(1)? }))
        })?
        .collect::<rusqlite::Result<_>>()?;

    Ok(Json(json!({
        "flat": flat_json,
        "members": members,
        "chores": chores,
        "activity": activity,
        "scores": scores,
        "rewards": rewards,
    })))
}

// ---------- flat & members ----------

#[derive(Deserialize)]
struct CreateFlat {
    name: String,
    member_name: String,
}

async fn create_flat(State(db): State<Shared>, Json(body): Json<CreateFlat>) -> ApiResult {
    let name = clean_name(&body.name, 40)?;
    let member_name = clean_name(&body.member_name, 40)?;
    let code: String = {
        let mut rng = rand::thread_rng();
        (0..CODE_LEN)
            .map(|_| CODE_ALPHABET[rng.gen_range(0..CODE_ALPHABET.len())] as char)
            .collect()
    };
    let mut c = db.lock().unwrap();
    let tx = c.transaction()?;
    tx.execute("INSERT INTO flats (name, code) VALUES (?1, ?2)", params![name, code])?;
    let flat = tx.last_insert_rowid();
    let member_id = insert_member(&tx, flat, &member_name)?;
    tx.commit()?;
    let Json(state) = load_state(&c, flat)?;
    Ok(Json(json!({ "member_id": member_id, "state": state })))
}

async fn get_state(State(db): State<Shared>, headers: HeaderMap) -> ApiResult {
    let c = db.lock().unwrap();
    let flat = auth(&c, &headers)?;
    load_state(&c, flat)
}

#[derive(Deserialize)]
struct NameBody {
    name: String,
}

async fn update_flat(
    State(db): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<NameBody>,
) -> ApiResult {
    let c = db.lock().unwrap();
    let flat = auth(&c, &headers)?;
    c.execute("UPDATE flats SET name = ?1 WHERE id = ?2", params![clean_name(&body.name, 40)?, flat])?;
    load_state(&c, flat)
}

#[derive(Deserialize)]
struct RewardBody {
    month: String,
    text: String,
}

/// The prize the flat plays for in a given month. A month without its own
/// entry inherits the most recent earlier one (the client resolves that).
async fn set_reward(
    State(db): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<RewardBody>,
) -> ApiResult {
    let c = db.lock().unwrap();
    let flat = auth(&c, &headers)?;
    if body.month.len() != 7 || parse_date(&format!("{}-01", body.month)).is_none() {
        return Err(ApiError::BadRequest("Invalid month"));
    }
    let text = body.text.trim();
    if text.chars().count() > 120 {
        return Err(ApiError::BadRequest("Keep the prize under 120 characters"));
    }
    c.execute(
        "INSERT INTO rewards (flat_id, month, text) VALUES (?1, ?2, ?3)
         ON CONFLICT (flat_id, month) DO UPDATE SET text = excluded.text",
        params![flat, body.month, text],
    )?;
    load_state(&c, flat)
}

async fn add_member(
    State(db): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<NameBody>,
) -> ApiResult {
    let mut c = db.lock().unwrap();
    let flat = auth(&c, &headers)?;
    let name = clean_name(&body.name, 40)?;
    let tx = c.transaction()?;
    let member_id = insert_member(&tx, flat, &name)?;
    sync_rotations(&tx, flat, true)?;
    tx.commit()?;
    let Json(state) = load_state(&c, flat)?;
    Ok(Json(json!({ "member_id": member_id, "state": state })))
}

async fn rename_member(
    State(db): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(body): Json<NameBody>,
) -> ApiResult {
    let c = db.lock().unwrap();
    let flat = auth(&c, &headers)?;
    require_member(&c, flat, id)?;
    c.execute("UPDATE members SET name = ?1 WHERE id = ?2", params![clean_name(&body.name, 40)?, id])?;
    load_state(&c, flat)
}

/// Members are deactivated, not deleted, so their history stays readable.
async fn remove_member(
    State(db): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult {
    let mut c = db.lock().unwrap();
    let flat = auth(&c, &headers)?;
    require_member(&c, flat, id)?;
    if active_members(&c, flat)?.len() <= 1 {
        return Err(ApiError::BadRequest("A flat needs at least one person"));
    }
    let tx = c.transaction()?;
    tx.execute("UPDATE members SET active = 0 WHERE id = ?1", [id])?;
    let chores: Vec<(i64, String, Option<i64>)> = tx
        .prepare("SELECT id, rotation, assignee_id FROM chores WHERE flat_id = ?1 AND archived = 0")?
        .query_map([flat], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (chore_id, rotation, assignee) in chores {
        let old: Vec<i64> = serde_json::from_str(&rotation).unwrap_or_default();
        if !old.contains(&id) {
            continue;
        }
        // Their turn passes to whoever was next.
        let assignee = if assignee == Some(id) {
            next_in_rotation(&old, assignee).filter(|&m| m != id)
        } else {
            assignee
        };
        let new: Vec<i64> = old.into_iter().filter(|&m| m != id).collect();
        tx.execute(
            "UPDATE chores SET rotation = ?1, assignee_id = ?2 WHERE id = ?3",
            params![rotation_json(&new), assignee, chore_id],
        )?;
    }
    sync_rotations(&tx, flat, false)?;
    tx.commit()?;
    load_state(&c, flat)
}

// ---------- chores ----------

#[derive(Deserialize)]
struct ChoreInput {
    title: String,
    icon: String,
    interval_n: u32,
    interval_unit: String,
    points: i64,
    assign_mode: String,
    #[serde(default)]
    rotation: Vec<i64>,
    #[serde(default)]
    assignee_id: Option<i64>,
    next_due: String,
}

/// Validates the input and resolves the rotation it implies.
fn chore_rotation(c: &Connection, flat: i64, input: &ChoreInput) -> Result<Vec<i64>, ApiError> {
    let title_len = input.title.trim().chars().count();
    if title_len == 0 || title_len > 80 {
        return Err(ApiError::BadRequest("Title must be 1 to 80 characters"));
    }
    if input.icon.chars().count() > 8 {
        return Err(ApiError::BadRequest("Invalid icon"));
    }
    if !(1..=365).contains(&input.interval_n)
        || !matches!(input.interval_unit.as_str(), "day" | "week" | "month")
    {
        return Err(ApiError::BadRequest("Invalid interval"));
    }
    if !(1..=3).contains(&input.points) {
        return Err(ApiError::BadRequest("Effort must be 1 to 3"));
    }
    if parse_date(&input.next_due).is_none() {
        return Err(ApiError::BadRequest("Invalid due date"));
    }
    let members = active_members(c, flat)?;
    match input.assign_mode.as_str() {
        "all" => Ok(members),
        "anyone" => Ok(vec![]),
        "custom" => {
            // Keep member order, drop duplicates and strangers.
            let picked: Vec<i64> =
                members.into_iter().filter(|m| input.rotation.contains(m)).collect();
            if picked.is_empty() {
                return Err(ApiError::BadRequest("Pick at least one person"));
            }
            Ok(picked)
        }
        _ => Err(ApiError::BadRequest("Invalid assignment")),
    }
}

async fn create_chore(
    State(db): State<Shared>,
    headers: HeaderMap,
    Json(input): Json<ChoreInput>,
) -> ApiResult {
    let c = db.lock().unwrap();
    let flat = auth(&c, &headers)?;
    let rotation = chore_rotation(&c, flat, &input)?;
    let assignee = match input.assignee_id.filter(|a| rotation.contains(a)) {
        Some(a) => Some(a),
        None => least_loaded(&c, flat, &rotation)?,
    };
    c.execute(
        "INSERT INTO chores (flat_id, title, icon, interval_n, interval_unit, points,
                             assign_mode, rotation, assignee_id, next_due)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            flat,
            input.title.trim(),
            input.icon,
            input.interval_n,
            input.interval_unit,
            input.points,
            input.assign_mode,
            rotation_json(&rotation),
            assignee,
            input.next_due
        ],
    )?;
    load_state(&c, flat)
}

async fn update_chore(
    State(db): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<ChoreInput>,
) -> ApiResult {
    let c = db.lock().unwrap();
    let flat = auth(&c, &headers)?;
    let existing = get_chore(&c, flat, id)?;
    let rotation = chore_rotation(&c, flat, &input)?;
    let keep = |a: &i64| rotation.contains(a);
    let assignee = match input.assignee_id.filter(keep).or(existing.assignee_id.filter(keep)) {
        Some(a) => Some(a),
        None => least_loaded(&c, flat, &rotation)?,
    };
    c.execute(
        "UPDATE chores SET title = ?1, icon = ?2, interval_n = ?3, interval_unit = ?4,
                           points = ?5, assign_mode = ?6, rotation = ?7, assignee_id = ?8,
                           next_due = ?9
         WHERE id = ?10",
        params![
            input.title.trim(),
            input.icon,
            input.interval_n,
            input.interval_unit,
            input.points,
            input.assign_mode,
            rotation_json(&rotation),
            assignee,
            input.next_due,
            id
        ],
    )?;
    load_state(&c, flat)
}

/// Chores are archived, not deleted, so past points still count.
async fn archive_chore(
    State(db): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult {
    let c = db.lock().unwrap();
    let flat = auth(&c, &headers)?;
    get_chore(&c, flat, id)?;
    c.execute("UPDATE chores SET archived = 1 WHERE id = ?1", [id])?;
    load_state(&c, flat)
}

#[derive(Deserialize)]
struct LogBody {
    member_id: i64,
    /// The client's local day, so "today" matches what the flat sees.
    date: String,
}

fn log_entry(
    c: &Connection,
    flat: i64,
    chore_id: i64,
    body: &LogBody,
    kind: &str,
    points: i64,
    chore: &ChoreRow,
) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO completions (flat_id, chore_id, member_id, kind, date, points,
                                  prev_due, prev_assignee)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![flat, chore_id, body.member_id, kind, body.date, points, chore.next_due, chore.assignee_id],
    )?;
    Ok(())
}

/// Whoever marks a chore done gets the points; the turn moves on and the next
/// due date counts from the day it was actually done.
async fn complete_chore(
    State(db): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(body): Json<LogBody>,
) -> ApiResult {
    let mut c = db.lock().unwrap();
    let flat = auth(&c, &headers)?;
    require_member(&c, flat, body.member_id)?;
    let chore = get_chore(&c, flat, id)?;
    let done_on = parse_date(&body.date).ok_or(ApiError::BadRequest("Invalid date"))?;
    let due = next_due(done_on, chore.interval_n, &chore.interval_unit)
        .ok_or(ApiError::BadRequest("Invalid interval"))?;
    let tx = c.transaction()?;
    log_entry(&tx, flat, id, &body, "done", chore.points, &chore)?;
    tx.execute(
        "UPDATE chores SET next_due = ?1, assignee_id = ?2 WHERE id = ?3",
        params![
            due.format(DATE_FMT).to_string(),
            next_in_rotation(&chore.rotation, chore.assignee_id),
            id
        ],
    )?;
    tx.commit()?;
    load_state(&c, flat)
}

/// Pass the turn to the next person without changing the due date.
async fn skip_chore(
    State(db): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(body): Json<LogBody>,
) -> ApiResult {
    let mut c = db.lock().unwrap();
    let flat = auth(&c, &headers)?;
    require_member(&c, flat, body.member_id)?;
    let chore = get_chore(&c, flat, id)?;
    if parse_date(&body.date).is_none() {
        return Err(ApiError::BadRequest("Invalid date"));
    }
    if chore.rotation.len() < 2 {
        return Err(ApiError::BadRequest("There is nobody to pass this chore to"));
    }
    let tx = c.transaction()?;
    log_entry(&tx, flat, id, &body, "skip", 0, &chore)?;
    tx.execute(
        "UPDATE chores SET assignee_id = ?1 WHERE id = ?2",
        params![next_in_rotation(&chore.rotation, chore.assignee_id), id],
    )?;
    tx.commit()?;
    load_state(&c, flat)
}

async fn undo_completion(
    State(db): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult {
    let mut c = db.lock().unwrap();
    let flat = auth(&c, &headers)?;
    let (chore_id, prev_due, prev_assignee): (i64, String, Option<i64>) = c
        .query_row(
            "SELECT chore_id, prev_due, prev_assignee FROM completions
             WHERE id = ?1 AND flat_id = ?2",
            [id, flat],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
        .ok_or(ApiError::NotFound)?;
    let chore = get_chore(&c, flat, chore_id)?;
    let latest: i64 = c.query_row(
        "SELECT MAX(id) FROM completions WHERE chore_id = ?1",
        [chore_id],
        |r| r.get(0),
    )?;
    if latest != id {
        return Err(ApiError::BadRequest("Only the latest entry of a chore can be undone"));
    }
    // The previous assignee may have left the flat or the rotation since.
    let assignee = match prev_assignee.filter(|a| chore.rotation.contains(a)) {
        Some(a) => Some(a),
        None => chore.assignee_id,
    };
    let tx = c.transaction()?;
    tx.execute("DELETE FROM completions WHERE id = ?1", [id])?;
    tx.execute(
        "UPDATE chores SET next_due = ?1, assignee_id = ?2 WHERE id = ?3",
        params![prev_due, assignee, chore_id],
    )?;
    tx.commit()?;
    load_state(&c, flat)
}
