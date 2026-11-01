"""Create a consistent SQLite backup while the ERP is running."""
import argparse
from contextlib import closing
import os
from pathlib import Path
import sqlite3


def backup(source, destination):
    source=Path(source).resolve()
    destination=Path(destination).resolve()
    if not source.is_file():
        raise ValueError('源数据库不存在')
    if source==destination:
        raise ValueError('备份不能覆盖源数据库')
    fd=os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    os.close(fd)
    try:
        with closing(sqlite3.connect(source.as_uri()+'?mode=ro',uri=True)) as src:
            with closing(sqlite3.connect(destination)) as dst:
                src.backup(dst)
                # Session removal must be checkpointed into the delivered single file.
                dst.execute('DELETE FROM sessions')
                dst.commit()
                dst.execute('PRAGMA wal_checkpoint(TRUNCATE)')
                mode=dst.execute('PRAGMA journal_mode=DELETE').fetchone()[0]
                if mode.lower()!='delete':
                    raise ValueError('备份未能转换为独立数据库文件')
                if dst.execute('PRAGMA integrity_check').fetchone()[0]!='ok':
                    raise ValueError('备份完整性检查失败')
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    return destination


if __name__=='__main__':
    parser=argparse.ArgumentParser(description='在线备份 ERP 数据库，不覆盖已有文件')
    parser.add_argument('source')
    parser.add_argument('destination')
    args=parser.parse_args()
    print('备份完成：',backup(args.source,args.destination))


class MonthlyBackup:
    """One verified snapshot per Beijing calendar month, with no retention deletion."""
    def __init__(self, source, folder):
        import threading
        self.source = Path(source).resolve()
        self.folder = Path(folder).resolve()
        self.lock = threading.Lock()
        self.last_error = ''
        self.last_checked = ''
        self.verified_snapshot = None

    def run_once(self, at=None):
        from datetime import datetime, timezone, timedelta
        import secrets
        clock = at or datetime.now(timezone.utc)
        clock = clock.astimezone(timezone(timedelta(hours=8)))
        month = clock.strftime('%Y-%m')
        with self.lock:
            self.last_checked = clock.isoformat(timespec='seconds')
            temporary = None
            try:
                self.folder.mkdir(parents=True, exist_ok=True, mode=0o700)
                target = self.folder / f'erp-{month}.sqlite3'
                if not target.exists():
                    temporary = self.folder / f'.{month}-{secrets.token_hex(8)}.partial'
                    backup(self.source, temporary)
                    # Publish only a complete snapshot; do not replace another process's snapshot.
                    try:
                        if os.name == 'nt':
                            os.rename(temporary, target)  # Windows rename refuses existing targets.
                        else:
                            os.link(temporary, target)
                    except FileExistsError:
                        pass
                info=target.stat()
                stamp=(str(target),info.st_size,info.st_mtime_ns)
                if stamp!=self.verified_snapshot:
                    with closing(sqlite3.connect(target.as_uri()+'?mode=ro', uri=True)) as db:
                        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                            raise ValueError('已有月度备份完整性检查失败，请保留文件并处理后重试')
                    self.verified_snapshot=stamp
                self.last_error = ''
            except Exception as error:
                self.last_error = str(error)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
            return self.status()

    def status(self):
        from datetime import datetime, timezone, timedelta
        month = datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m')
        snapshots = sorted(self.folder.glob('erp-????-??.sqlite3')) if self.folder.exists() else []
        return {
            'month': month,
            'current_exists': (self.folder / f'erp-{month}.sqlite3').exists(),
            'latest': snapshots[-1].name if snapshots else '',
            'folder': str(self.folder.resolve()),
            'last_checked': self.last_checked,
            'error': self.last_error,
        }
