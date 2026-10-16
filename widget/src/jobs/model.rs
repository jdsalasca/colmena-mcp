use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
    Orphaned,
}

impl JobState {
    pub const fn is_active(self) -> bool {
        matches!(self, Self::Queued | Self::Running)
    }

    pub const fn is_terminal(self) -> bool {
        !self.is_active()
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub state: JobState,
    pub kind: Option<String>,
    pub task: Option<String>,
    pub worker: Option<String>,
    pub provider: Option<String>,
    pub branch: Option<String>,
    pub created_at: Option<i64>,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub cost_usd: Option<f64>,
}
