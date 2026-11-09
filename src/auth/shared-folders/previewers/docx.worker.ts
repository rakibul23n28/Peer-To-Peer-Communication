import mammoth from "mammoth"

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  void mammoth.convertToHtml({ arrayBuffer: event.data }).then((result) => {
    self.postMessage({ html: result.value })
  }).catch(() => {
    self.postMessage({ error: "This DOCX file could not be previewed." })
  })
}
