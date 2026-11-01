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
