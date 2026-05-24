import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
// レスポンシブ対応 PR1: グローバル CSS。box-sizing / mobile 時の font-size
// 等の「インラインで書きづらいベース調整」だけをここで適用する。
import "./styles/responsive.css";
// HitoLink Design System 試験適用 (revert 可): tokens / .btn-* / .anim-* /
// .skel / .material-symbols-rounded 等のクラスを提供する。リバートしたい場合は
// この行を削除するだけで、既存のインラインスタイル UI に戻る。
import "./styles/hitolink.css";

const root = createRoot(document.getElementById("root")!);
root.render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
