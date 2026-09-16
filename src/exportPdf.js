// src/exportPdf.js
// 通用导出工具：用 html2canvas 截图元素 → 导出 PDF（强制一页 A4）或 PNG。
// 关键：保持元素真实尺寸截图，不手动 transform/scale；jsPDF 自己算 fitScale 强制一页。
// 调用方负责传入「干净可截图」的元素（如 ResumeBuilder 传克隆体，Report 传 reportArea）。

async function renderToCanvas(el, { scale = 2, backgroundColor = '#ffffff' } = {}) {
  const [{ default: html2canvas }] = await Promise.all([import('html2canvas')])
  return html2canvas(el, {
    scale,
    useCORS: true,
    backgroundColor,
    logging: false,
  })
}

function triggerDownload(href, filename) {
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

// 导出为 PNG 图片
export async function exportElementToImage(el, filename, opts = {}) {
  const canvas = await renderToCanvas(el, opts)
  triggerDownload(canvas.toDataURL('image/png'), filename)
}

// 导出为 PDF：整张纸等比缩放进一页 A4，居中输出
export async function exportElementToPdf(el, filename, opts = {}) {
  const scale = opts.scale ?? 2
  const [{ jsPDF }] = await Promise.all([import('jspdf')])
  const canvas = await renderToCanvas(el, opts)
  const pageW = 210
  const pageH = 297
  const pxToMm = 25.4 / 96
  // canvas 是 scale 倍图，真实 CSS 宽高要除 scale
  const imgW = (canvas.width / scale) * pxToMm
  const imgH = (canvas.height / scale) * pxToMm
  // 等比缩放，确保整张纸（含超出 A4 的内容）都能塞进一页
  const fitScale = Math.min(pageW / imgW, pageH / imgH, 1)
  const drawW = imgW * fitScale
  const drawH = imgH * fitScale
  const x = (pageW - drawW) / 2
  const y = (pageH - drawH) / 2
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  pdf.addImage(canvas.toDataURL('image/jpeg', 0.98), 'JPEG', x, y, drawW, drawH)
  pdf.save(filename)
}
