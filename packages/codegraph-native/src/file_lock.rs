use std::fs::{File, OpenOptions, TryLockError};

use napi::bindgen_prelude::Result;
use napi_derive::napi;

/// An exclusive kernel lock. Dropping the handle also releases the lock.
#[napi]
pub struct NativeExclusiveLock {
    file: Option<File>,
}

#[napi]
impl NativeExclusiveLock {
    #[napi]
    pub fn unlock(&mut self) {
        self.file.take();
    }
}

fn may_open_read_only(kind: std::io::ErrorKind) -> bool {
    matches!(
        kind,
        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::ReadOnlyFilesystem
    )
}

/// Attempts to lock a persistent file without waiting.
#[napi]
pub fn try_lock_exclusive(path: String) -> Result<Option<NativeExclusiveLock>, &'static str> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o666);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // A holder or waiter must prevent the path from being replaced while its handle is open.
        options.share_mode(0x0000_0001 | 0x0000_0002);
    }
    let file = options.open(&path).or_else(|error| {
        if !may_open_read_only(error.kind()) {
            return Err(error);
        }
        let mut fallback = OpenOptions::new();
        fallback.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            fallback.share_mode(0x0000_0001 | 0x0000_0002);
        }
        match fallback.open(&path) {
            Err(fallback_error) if fallback_error.kind() == std::io::ErrorKind::NotFound => Err(error),
            result => result,
        }
    });
    let file = file.map_err(|error| {
        if error.kind() == std::io::ErrorKind::PermissionDenied {
            let directory = std::path::Path::new(&path)
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or_else(|| std::path::Path::new("."));
            return napi::Error::new(
                "CODEGRAPH_LOCK_OPEN_FAILED",
                format!(
                    "Cannot open lock file {path}: permission denied. Fix ownership of lock directory {} \
                     (on Unix, for example: chown -R <user> <directory>), then retry.",
                    directory.display()
                ),
            );
        }
        napi::Error::new(
            "CODEGRAPH_LOCK_OPEN_FAILED",
            format!("Cannot open lock file {path}: {error}"),
        )
    })?;
    match file.try_lock() {
        Ok(()) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                let held = file.metadata().map_err(|error| {
                    napi::Error::new(
                        "CODEGRAPH_LOCK_IO_FAILED",
                        format!("Cannot inspect lock file {path}: {error}"),
                    )
                })?;
                let published = match std::fs::metadata(&path) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                    Err(error) => {
                        return Err(napi::Error::new(
                            "CODEGRAPH_LOCK_IO_FAILED",
                            format!("Cannot inspect lock file {path}: {error}"),
                        ));
                    }
                };
                if held.dev() != published.dev() || held.ino() != published.ino() {
                    return Ok(None);
                }
            }
            Ok(Some(NativeExclusiveLock { file: Some(file) }))
        }
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(napi::Error::new(
            "CODEGRAPH_LOCK_IO_FAILED",
            format!("Cannot lock file {path}: {error}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::{may_open_read_only, try_lock_exclusive};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn retries_read_only_for_permission_and_read_only_filesystem_errors() {
        assert!(may_open_read_only(std::io::ErrorKind::PermissionDenied));
        assert!(may_open_read_only(std::io::ErrorKind::ReadOnlyFilesystem));
        assert!(!may_open_read_only(std::io::ErrorKind::NotFound));
    }

    #[test]
    fn exclusive_lock_is_released_by_unlock_and_drop() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("codegraph-lock-{}-{nonce}", std::process::id()));
        let path_string = path.to_string_lossy().into_owned();
        let mut first = try_lock_exclusive(path_string.clone()).unwrap().unwrap();
        assert!(try_lock_exclusive(path_string.clone()).unwrap().is_none());
        first.unlock();
        let second = try_lock_exclusive(path_string.clone()).unwrap().unwrap();
        assert!(try_lock_exclusive(path_string.clone()).unwrap().is_none());
        drop(second);
        assert!(try_lock_exclusive(path_string).unwrap().is_some());
        std::fs::remove_file(path).unwrap();
    }
}
