use super::format_elapsed_ms;
use crate::jobs::Job;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Tooltip {
    pub worker: String,
    pub kind: String,
    pub task: String,
    pub elapsed: String,
    pub cost: String,
}

pub fn tooltip_for(job: &Job, now_ms: i64) -> Tooltip {
    let elapsed_ms = match job.state {
        crate::jobs::JobState::Queued => elapsed_since(now_ms, job.created_at),
        crate::jobs::JobState::Running => elapsed_since(now_ms, job.started_at.or(job.created_at)),
        crate::jobs::JobState::Done
        | crate::jobs::JobState::Failed
        | crate::jobs::JobState::Cancelled
        | crate::jobs::JobState::Orphaned => {
            let end = job.ended_at;
            let start = job.started_at.or(job.created_at).or(end);
            match (start, end) {
                (Some(start), Some(end)) => end.saturating_sub(start).max(0),
                _ => 0,
            }
        }
    };

    Tooltip {
        worker: job.worker.as_deref().unwrap_or("desconocido").to_owned(),
        kind: job.kind.as_deref().unwrap_or("job").to_owned(),
        task: job.task.as_deref().unwrap_or("").chars().take(60).collect(),
        elapsed: format_elapsed_ms(elapsed_ms),
        cost: job
            .cost_usd
            .map(|cost| format!("{cost:.4}"))
            .unwrap_or_else(|| "pendiente".to_owned()),
    }
}

fn elapsed_since(now_ms: i64, start_ms: Option<i64>) -> i64 {
    start_ms
        .map(|start| now_ms.saturating_sub(start).max(0))
        .unwrap_or(0)
}
