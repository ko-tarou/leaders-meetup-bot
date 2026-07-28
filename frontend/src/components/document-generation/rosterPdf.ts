// document_generation (名簿生成): 画面上の名簿テーブルを PDF 化して自動ダウンロードする。
//
// 設計:
//   日本語 PDF はフォント埋め込みが必要でバンドルが肥大化するため、
//   「画面に表示済みの名簿要素を html2canvas でラスタライズ → jsPDF に貼る」方式を採る。
//   これで OS のフォントでレンダリングされた日本語をそのまま PDF に載せられる。
//   jspdf / html2canvas はボタン押下時に dynamic import し、メインバンドルを太らせない。
//
//   長い名簿は A4 縦 1 ページに収まらないため、キャンバスを縦にスライスして複数ページに分割する。

// 対象要素を A4 縦 PDF (複数ページ) にして保存する。
export async function downloadRosterPdf(
  el: HTMLElement,
  filename: string,
): Promise<void> {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
    import("html2canvas"),
    import("jspdf"),
  ]);

  // 実寸の 2 倍で描画して印刷に耐える解像度にする。背景は白で固定。
  const canvas = await html2canvas(el, {
    scale: 2,
    backgroundColor: "#ffffff",
    useCORS: true,
  });

  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 8; // mm
  const contentW = pageW - margin * 2;
  const contentH = pageH - margin * 2;

  // canvas 全体を contentW に合わせた時の高さ (mm)。
  const imgH = (canvas.height * contentW) / canvas.width;

  if (imgH <= contentH) {
    // 1 ページに収まる。
    const img = canvas.toDataURL("image/png");
    pdf.addImage(img, "PNG", margin, margin, contentW, imgH);
    pdf.save(filename);
    return;
  }

  // 収まらない → canvas を縦にスライスして複数ページに分割する。
  // 1 ページ分の canvas ピクセル高さ。
  const pageCanvasH = Math.floor((canvas.width * contentH) / contentW);
  let renderedH = 0;
  let first = true;
  while (renderedH < canvas.height) {
    const sliceH = Math.min(pageCanvasH, canvas.height - renderedH);
    const slice = document.createElement("canvas");
    slice.width = canvas.width;
    slice.height = sliceH;
    const ctx = slice.getContext("2d");
    if (!ctx) break;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, slice.width, slice.height);
    ctx.drawImage(
      canvas,
      0,
      renderedH,
      canvas.width,
      sliceH,
      0,
      0,
      canvas.width,
      sliceH,
    );
    const sliceImgH = (sliceH * contentW) / canvas.width;
    if (!first) pdf.addPage();
    pdf.addImage(
      slice.toDataURL("image/png"),
      "PNG",
      margin,
      margin,
      contentW,
      sliceImgH,
    );
    renderedH += sliceH;
    first = false;
  }
  pdf.save(filename);
}
