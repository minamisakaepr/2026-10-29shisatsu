import Link from "next/link";

export default function Home() {
  return (
    <>
      <h1>パン屋のおつかい、まとめて。</h1>
      <div className="card stack">
        <p>近所のパン屋の商品をアプリで注文すると、近所の「パシリ」さんが何人分かをまとめて買って、届けてくれます。</p>
        <p className="muted">注文時はカードの仮押さえだけ。受け取ったときに、実際の金額だけが確定します。</p>
        <div className="row">
          <Link className="btn" href="/customer">注文する</Link>
          <Link className="btn secondary" href="/runner">パシリをする</Link>
        </div>
      </div>
      <div className="card small muted">
        アカウントがない方は <Link href="/signup">新規登録</Link>。お店・運営の方はログインしてください。
      </div>
    </>
  );
}
