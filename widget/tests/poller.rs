use colmena_widget::jobs::{Job, JobState};
use colmena_widget::poller::{PollMessage, Poller};
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

fn job(id: &str) -> Job {
    Job {
        id: id.to_owned(),
        state: JobState::Queued,
        kind: Some("run".to_owned()),
        task: Some("test poller".to_owned()),
        worker: Some("luna-max".to_owned()),
        provider: None,
        branch: None,
        created_at: Some(1_000),
        started_at: None,
        ended_at: None,
        cost_usd: None,
    }
}

fn home() -> PathBuf {
    std::env::temp_dir().join("colmena-widget-poller-test-home")
}

#[test]
fn reader_runs_immediately_and_sends_the_complete_snapshot() {
    let calls = Arc::new(AtomicUsize::new(0));
    let reader_calls = Arc::clone(&calls);
    let expected_home = home();
    let reader_home = expected_home.clone();
    let mut poller = Poller::with_interval(expected_home, Duration::from_secs(5), move |path| {
        assert_eq!(path, reader_home.as_path());
        reader_calls.fetch_add(1, Ordering::SeqCst);
        Ok(vec![job("immediate")])
    })
    .unwrap();

    let message = poller.recv_timeout(Duration::from_millis(500)).unwrap();

    assert_eq!(message, PollMessage::Snapshot(vec![job("immediate")]));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    poller.stop();
}

#[test]
fn reader_runs_again_after_the_configured_interval() {
    let calls = Arc::new(AtomicUsize::new(0));
    let reader_calls = Arc::clone(&calls);
    let mut poller = Poller::with_interval(home(), Duration::from_millis(30), move |_| {
        let call = reader_calls.fetch_add(1, Ordering::SeqCst) + 1;
        Ok(vec![job(&format!("poll-{call}"))])
    })
    .unwrap();

    let first = poller.recv_timeout(Duration::from_millis(500)).unwrap();
    let started = Instant::now();
    let second = poller.recv_timeout(Duration::from_millis(500)).unwrap();

    assert_eq!(first, PollMessage::Snapshot(vec![job("poll-1")]));
    assert_eq!(second, PollMessage::Snapshot(vec![job("poll-2")]));
    assert!(started.elapsed() >= Duration::from_millis(20));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    poller.stop();
}

#[test]
fn read_errors_are_reported_and_do_not_prevent_later_snapshots() {
    let calls = Arc::new(AtomicUsize::new(0));
    let reader_calls = Arc::clone(&calls);
    let mut poller = Poller::with_interval(home(), Duration::from_millis(20), move |_| {
        if reader_calls.fetch_add(1, Ordering::SeqCst) == 0 {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "fixture unreadable",
            ))
        } else {
            Ok(vec![job("after-error")])
        }
    })
    .unwrap();

    assert_eq!(
        poller.recv_timeout(Duration::from_millis(500)).unwrap(),
        PollMessage::Error {
            kind: io::ErrorKind::PermissionDenied,
            message: "fixture unreadable".to_owned(),
        }
    );
    assert_eq!(
        poller.recv_timeout(Duration::from_millis(500)).unwrap(),
        PollMessage::Snapshot(vec![job("after-error")])
    );
    poller.stop();
}

#[test]
fn stop_cancels_the_polling_thread_and_prevents_more_reads() {
    let calls = Arc::new(AtomicUsize::new(0));
    let reader_calls = Arc::clone(&calls);
    let mut poller = Poller::with_interval(home(), Duration::from_millis(10), move |_| {
        reader_calls.fetch_add(1, Ordering::SeqCst);
        Ok(Vec::new())
    })
    .unwrap();
    let _ = poller.recv_timeout(Duration::from_millis(500)).unwrap();
    poller.stop();
    let stopped_at = calls.load(Ordering::SeqCst);

    std::thread::sleep(Duration::from_millis(50));

    assert!(poller.is_stopped());
    assert_eq!(calls.load(Ordering::SeqCst), stopped_at);
}
