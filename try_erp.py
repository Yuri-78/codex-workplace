"""Local desktop demo launcher; never changes the company's production account book."""
import argparse
import errno
import os
from pathlib import Path
import threading
import webbrowser

from server import ERP, ROOT, make_server


def prepare_demo(directory, port=8000):
    directory = Path(directory)
    first_run = not (directory / 'erp.sqlite3').exists()
    erp = ERP(directory, demo=True)
    (directory / 'demo-mode').touch()
    try:
        server = make_server(erp, port=port)
    except OSError as error:
        if error.errno != errno.EADDRINUSE and getattr(error, 'winerror', None) != 10048:
            raise
        # Never send credentials to another program that happens to own port 8000.
        server = make_server(erp, port=0)
    return server, first_run


def main():
    parser = argparse.ArgumentParser(description='在本机启动独立的 ERP 演示账套并打开浏览器')
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    directory = ROOT / '.data' / 'windows-demo'
    server, first_run = prepare_demo(directory, args.port)
    url = f'http://127.0.0.1:{server.server_port}'
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(f'ERP 已在你的电脑启动：{url}', flush=True)
    print('这是演示账套，含虚构数据；请勿录入真实业务。', flush=True)
    print(f'初始账号文件：{directory / "initial-accounts.txt"}', flush=True)
    print('首次登录后可修改密码；修改后原文件中的密码不再有效。', flush=True)
    print('试用时请保持此窗口打开。按 Ctrl+C 可停止。', flush=True)
    try:
        if not args.no_browser:
            if first_run and os.name == 'nt':
                try:
                    os.startfile(str(directory / 'initial-accounts.txt'))
                except OSError:
                    print('请按上方路径自行打开初始账号文件。', flush=True)
            try:
                if not webbrowser.open(url):
                    print('请将上方地址复制到浏览器中打开。', flush=True)
            except webbrowser.Error:
                print('请将上方地址复制到浏览器中打开。', flush=True)
        thread.join()
    except KeyboardInterrupt:
        print('\n演示服务已停止，演示数据已保留。', flush=True)
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


if __name__ == '__main__':
    main()
