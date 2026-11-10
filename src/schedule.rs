//! Pure scheduling rules: when a chore is due next and whose turn it is.

use chrono::{Days, Months, NaiveDate};

pub const DATE_FMT: &str = "%Y-%m-%d";

pub fn parse_date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, DATE_FMT).ok()
}

/// The next due date for a chore completed on `from`.
/// Month intervals clamp to the end of shorter months (Jan 31 + 1 month = Feb 28/29).
pub fn next_due(from: NaiveDate, n: u32, unit: &str) -> Option<NaiveDate> {
    match unit {
        "day" => from.checked_add_days(Days::new(n as u64)),
        "week" => from.checked_add_days(Days::new(n as u64 * 7)),
        "month" => from.checked_add_months(Months::new(n)),
        _ => None,
    }
}

/// Who comes after `current` in the rotation. Nobody if the rotation is empty;
/// the first person if `current` is not part of it.
pub fn next_in_rotation(rotation: &[i64], current: Option<i64>) -> Option<i64> {
    if rotation.is_empty() {
        return None;
    }
    let idx = current.and_then(|c| rotation.iter().position(|&m| m == c));
    Some(match idx {
        Some(i) => rotation[(i + 1) % rotation.len()],
        None => rotation[0],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        parse_date(s).unwrap()
    }

    #[test]
    fn intervals() {
        assert_eq!(next_due(d("2026-11-10"), 3, "day"), Some(d("2026-11-13")));
        assert_eq!(next_due(d("2026-11-10"), 2, "week"), Some(d("2026-11-24")));
        assert_eq!(next_due(d("2026-11-10"), 1, "month"), Some(d("2026-12-10")));
        assert_eq!(next_due(d("2026-12-20"), 1, "month"), Some(d("2027-01-20")));
        assert_eq!(next_due(d("2026-11-10"), 1, "year"), None);
    }

    #[test]
    fn month_end_clamps() {
        assert_eq!(next_due(d("2027-01-31"), 1, "month"), Some(d("2027-02-28")));
        assert_eq!(next_due(d("2028-01-31"), 1, "month"), Some(d("2028-02-29")));
    }

    #[test]
    fn rotation() {
        assert_eq!(next_in_rotation(&[], Some(1)), None);
        assert_eq!(next_in_rotation(&[1, 2, 3], Some(1)), Some(2));
        assert_eq!(next_in_rotation(&[1, 2, 3], Some(3)), Some(1));
        assert_eq!(next_in_rotation(&[1, 2, 3], Some(9)), Some(1));
        assert_eq!(next_in_rotation(&[1, 2, 3], None), Some(1));
        assert_eq!(next_in_rotation(&[5], Some(5)), Some(5));
    }
}
