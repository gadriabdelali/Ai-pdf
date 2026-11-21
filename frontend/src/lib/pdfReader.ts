import * as pdfjsLib from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

export async function extractPDFText(file: File): Promise<string> {
  const startTime = Date.now()

  const data = await file.arrayBuffer()

  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(data),
  }).promise

  try {
    const totalPages = pdf.numPages
    const pages: string[] = new Array(totalPages)

    let nextPage = 1

    // عدد الصفحات التي تتم معالجتها بالتوازي
    const concurrency = Math.min(3, totalPages)

    async function worker() {
      while (true) {
        const pageNumber = nextPage++

        if (pageNumber > totalPages) break

        const page = await pdf.getPage(pageNumber)
        const content = await page.getTextContent()

        pages[pageNumber - 1] = content.items
          .filter((item) => 'str' in item)
          .map((item) => 'str' in item ? item.str : '')
          .join(' ')

        console.log(
          `PDF reading: ${pageNumber}/${totalPages}`
        )
      }
    }

    await Promise.all(
      Array.from({ length: concurrency }, () => worker())
    )

    const result = pages.join('\n\n').trim()

    console.log(
      `PDF extracted: ${totalPages} pages, ${result.length} characters, ${(Date.now() - startTime) / 1000}s`
    )

    return result

  } finally {
    await pdf.cleanup()
  }
}
