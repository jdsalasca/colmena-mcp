use colmena_widget::jobs::{Job, JobState, read_snapshot, resolve_home};
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "colmena-widget-jobs-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn job(&self, id: &str, meta: &str) -> PathBuf {
        let dir = self.0.join("jobs").join(id);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("meta.json");
        fs::write(&path, meta).unwrap();
        path
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn resolve_home_prefers_nonempty_override_and_falls_back_to_profile() {
    let explicit = resolve_home(
        Some(OsStr::new("D:/colmena-data")),
        Some(OsStr::new("C:/Users/test")),
    )
    .unwrap();
    assert_eq!(explicit, PathBuf::from("D:/colmena-data"));

    let fallback = resolve_home(Some(OsStr::new("")), Some(OsStr::new("C:/Users/test"))).unwrap();
    assert_eq!(fallback, PathBuf::from("C:/Users/test/.colmena"));
}

#[test]
fn resolve_home_reports_an_error_when_both_sources_are_missing() {
    let error = resolve_home(None, None).unwrap_err();
    assert!(error.to_string().contains("COLMENA_HOME"));
    assert!(error.to_string().contains("USERPROFILE"));
}

#[test]
fn missing_jobs_directory_is_an_empty_snapshot() {
    let fixture = Fixture::new();
    assert!(read_snapshot(fixture.path()).unwrap().is_empty());
}

#[test]
fn all_six_states_use_the_exact_lowercase_node_values() {
    let cases = [
        (JobState::Queued, "queued"),
        (JobState::Running, "running"),
        (JobState::Done, "done"),
        (JobState::Failed, "failed"),
        (JobState::Cancelled, "cancelled"),
        (JobState::Orphaned, "orphaned"),
    ];

    for (state, expected) in cases {
        assert_eq!(
            serde_json::to_string(&state).unwrap(),
            format!("\"{expected}\"")
        );
        assert_eq!(
            serde_json::from_str::<JobState>(&format!("\"{expected}\"")).unwrap(),
            state
        );
    }
}

#[test]
fn optional_metadata_can_be_absent_and_unknown_fields_are_ignored() {
    let job: Job =
        serde_json::from_str(r#"{"id":"abc","state":"queued","futureNodeField":{"revision":2}}"#)
            .unwrap();

    assert_eq!(job.id, "abc");
    assert_eq!(job.state, JobState::Queued);
    assert!(job.kind.is_none());
    assert!(job.task.is_none());
    assert!(job.worker.is_none());
    assert!(job.provider.is_none());
    assert!(job.branch.is_none());
    assert!(job.created_at.is_none());
    assert!(job.started_at.is_none());
    assert!(job.ended_at.is_none());
    assert!(job.cost_usd.is_none());
}

#[test]
fn absent_cost_remains_distinct_from_a_zero_cost() {
    let absent: Job = serde_json::from_str(r#"{"id":"a","state":"done"}"#).unwrap();
    let zero: Job = serde_json::from_str(r#"{"id":"b","state":"done","costUsd":0}"#).unwrap();

    assert_eq!(absent.cost_usd, None);
    assert_eq!(zero.cost_usd, Some(0.0));
}

#[test]
fn reader_sorts_by_id_and_omits_invalid_json_unknown_state_and_non_direct_entries() {
    let fixture = Fixture::new();
    fixture.job(
        "z-last",
        r#"{"id":"z-last","state":"running","startedAt":1700000000123}"#,
    );
    fixture.job("m-invalid", "{ incomplete");
    fixture.job("n-unknown", r#"{"id":"n-unknown","state":"sleeping"}"#);
    fixture.job(
        "a-first",
        r#"{"id":"a-first","state":"queued","createdAt":1700000000000}"#,
    );
    fs::create_dir_all(fixture.path().join("jobs").join("nested").join("child")).unwrap();
    fs::write(
        fixture
            .path()
            .join("jobs")
            .join("nested")
            .join("child")
            .join("meta.json"),
        r#"{"id":"deep","state":"running"}"#,
    )
    .unwrap();
    fs::write(
        fixture.path().join("jobs").join("README.txt"),
        "not a job directory",
    )
    .unwrap();

    let jobs = read_snapshot(fixture.path()).unwrap();
    let ids: Vec<_> = jobs.iter().map(|job| job.id.as_str()).collect();
    assert_eq!(ids, ["a-first", "z-last"]);
    assert_eq!(jobs[0].created_at, Some(1_700_000_000_000));
    assert_eq!(jobs[1].started_at, Some(1_700_000_000_123));
}

#[test]
fn reading_a_snapshot_does_not_change_fixture_files() {
    let fixture = Fixture::new();
    let meta_path = fixture.job(
        "read-only",
        r#"{"id":"read-only","state":"running","task":"leave me alone"}"#,
    );
    let before = fs::read(&meta_path).unwrap();

    let jobs = read_snapshot(fixture.path()).unwrap();

    assert_eq!(jobs.len(), 1);
    assert_eq!(fs::read(meta_path).unwrap(), before);
}
