import Dexie, { type Table } from 'dexie'

export interface PDFRecord {
  id?: number
  name: string
  size: string
  blob: Blob
  createdAt: number
}

class MultiPDFDatabase extends Dexie {
  pdfs!: Table<PDFRecord, number>

  constructor() {
    super('MultiPDFDatabase')

    this.version(1).stores({
      pdfs: '++id, name, createdAt'
    })
  }
}

export const db = new MultiPDFDatabase()
