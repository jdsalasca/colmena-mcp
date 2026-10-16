use crate::jobs::Job;
use std::io;
use std::path::Path;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

#[derive(Clone, Debug, PartialEq)]
pub enum PollMessage {
    Snapshot(Vec<Job>),
    Error {
        kind: io::ErrorKind,
        message: String,
    },
}

pub struct Poller {
    receiver: Receiver<PollMessage>,
    cancel: Sender<()>,
    thread: Option<JoinHandle<()>>,
}

impl Poller {
    pub fn start<R>(home: impl Into<std::path::PathBuf>, reader: R) -> io::Result<Self>
    where
        R: Fn(&Path) -> io::Result<Vec<Job>> + Send + 'static,
    {
        Self::with_interval(home, Duration::from_secs(1), reader)
    }

    pub fn with_interval<R>(
        home: impl Into<std::path::PathBuf>,
        interval: Duration,
        reader: R,
    ) -> io::Result<Self>
    where
        R: Fn(&Path) -> io::Result<Vec<Job>> + Send + 'static,
    {
        let home = home.into();
        let (sender, receiver) = mpsc::channel();
        let (cancel, cancel_receiver) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("colmena-widget-poller".to_owned())
            .spawn(move || {
                loop {
                    let message = match reader(&home) {
                        Ok(snapshot) => PollMessage::Snapshot(snapshot),
                        Err(error) => PollMessage::Error {
                            kind: error.kind(),
                            message: error.to_string(),
                        },
                    };
                    if sender.send(message).is_err() {
                        break;
                    }
                    match cancel_receiver.recv_timeout(interval) {
                        Ok(()) | Err(RecvTimeoutError::Disconnected) => break,
                        Err(RecvTimeoutError::Timeout) => {}
                    }
                }
            })?;
        Ok(Self {
            receiver,
            cancel,
            thread: Some(thread),
        })
    }

    pub fn try_recv(&self) -> Result<PollMessage, TryRecvError> {
        self.receiver.try_recv()
    }

    pub fn recv_timeout(&self, timeout: Duration) -> Result<PollMessage, RecvTimeoutError> {
        self.receiver.recv_timeout(timeout)
    }

    pub fn stop(&mut self) {
        let _ = self.cancel.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }

    pub fn is_stopped(&self) -> bool {
        self.thread.is_none()
    }
}

impl Drop for Poller {
    fn drop(&mut self) {
        self.stop();
    }
}
