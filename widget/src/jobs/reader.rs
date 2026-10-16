use super::Job;
use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HomeError {
    Missing,
}

impl std::fmt::Display for HomeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing => formatter.write_str("se requiere COLMENA_HOME o USERPROFILE"),
        }
    }
}

impl std::error::Error for HomeError {}

pub fn resolve_home(
    env_home: Option<&OsStr>,
    user_profile: Option<&OsStr>,
) -> Result<PathBuf, HomeError> {
    if let Some(home) = env_home.filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(home));
    }

    if let Some(profile) = user_profile.filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(profile).join(".colmena"));
    }

    Err(HomeError::Missing)
}

pub fn read_snapshot(home: &Path) -> io::Result<Vec<Job>> {
    let jobs_dir = home.join("jobs");
    match std::fs::symlink_metadata(&jobs_dir) {
        Ok(metadata) if metadata.file_type().is_symlink() => return Ok(Vec::new()),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    }

    let mut jobs = Vec::new();
    for entry in std::fs::read_dir(jobs_dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if !file_type.is_dir() {
            continue;
        }

        let metadata_path = entry.path().join("meta.json");
        let Ok(bytes) = std::fs::read(metadata_path) else {
            continue;
        };
        if let Ok(job) = serde_json::from_slice(&bytes) {
            jobs.push(job);
        }
    }

    jobs.sort_by(|left: &Job, right: &Job| left.id.cmp(&right.id));
    Ok(jobs)
}
