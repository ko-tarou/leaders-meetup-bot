import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
// レスポンシブ対応 PR1: グローバル CSS。box-sizing / mobile 時の font-size
// 等の「インラインで書きづらいベース調整」だけをここで適用する。
import "./styles/responsive.css";

const root = createRoot(document.getElementById("root")!);
root.render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
