// レスポンシブ対応 PR1: CSS の side-effect import に対する型宣言。
// Vite は `import "./foo.css"` を bundle してくれるが、tsc 単体では
// declaration が無く TS2882 になるため、ここで side-effect モジュールとして
// 受け入れるよう宣言する。
declare module "*.css";
