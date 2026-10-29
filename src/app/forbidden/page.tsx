import Link from "next/link";

export default function Forbidden() {
  return (
    <div className="card">
      <h1>このページは見られません</h1>
      <p>この画面を使う権限がありません。別のアカウントでログインするか、トップに戻ってください。</p>
      <p className="row">
        <Link className="btn" href="/">トップへ</Link>
        <Link className="btn secondary" href="/login">ログインし直す</Link>
      </p>
    </div>
  );
}
