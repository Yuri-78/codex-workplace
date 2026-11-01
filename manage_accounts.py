"""Local administrator password recovery. No credentials accepted in CLI arguments."""
import argparse
import getpass
from pathlib import Path
import secrets
import sqlite3
import sys

from server import BusinessError, now, password_hash


def reset_password(database, username, new_password):
    if not 12 <= len(new_password) <= 128:
        raise BusinessError('新密码需为 12–128 个字符')
    # mode=rw refuses missing files instead of accidentally creating another account database.
    uri=Path(database).resolve().as_uri()+'?mode=rw'
    db=sqlite3.connect(uri,uri=True,timeout=15)
    try:
        with db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT id FROM users WHERE username=?',(username,)).fetchone()
            if not row:
                raise BusinessError('账号不存在')
            salt=secrets.token_hex(16)
            db.execute('UPDATE users SET salt=?,password=? WHERE id=?',(salt,password_hash(new_password,salt),row[0]))
            db.execute('DELETE FROM sessions WHERE user_id=?',(row[0],))
            db.execute('INSERT INTO audit(actor,action,reference,created) VALUES(?,?,?,?)',('服务器管理员','reset_password',username,now()))
    finally:
        db.close()


def main():
    parser=argparse.ArgumentParser(description='服务器管理员通过终端重置 ERP 密码')
    parser.add_argument('--data-dir',required=True,help='已有账套所在目录')
    parser.add_argument('action',choices=['reset'])
    parser.add_argument('username',choices=['admin','sales','warehouse','production'])
    args=parser.parse_args()
    if not sys.stdin.isatty():
        parser.error('请在交互式终端运行，密码不接受命令行参数、管道或聊天输入')
    try:
        password=getpass.getpass('请输入新密码（12–128 字符，不显示）：')
        confirmation=getpass.getpass('请再次输入新密码：')
        if password!=confirmation:
            raise BusinessError('两次密码不一致，没有修改')
        reset_password(Path(args.data_dir)/'erp.sqlite3',args.username,password)
    except (BusinessError,sqlite3.Error) as error:
        print(f'未完成重置：{error}',file=sys.stderr)
        return 1
    print(f'{args.username} 的密码已重置，原有登录会话已失效。请安全分发新密码。')
    return 0


if __name__=='__main__':
    raise SystemExit(main())
