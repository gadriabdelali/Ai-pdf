import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { GoogleGenAI } from '@google/genai'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const app = express()

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'https://localhost',
  'capacitor://localhost',
  ...(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
]

app.use(cors({ origin: allowedOrigins }))

app.use(express.json({ limit: '15mb' }))

const apiKey = process.env.GEMINI_API_KEY

if (!apiKey || apiKey === 'ضع_مفتاحك_هنا') {
  console.error('GEMINI_API_KEY is missing in .env')
  process.exit(1)
}

const ai = new GoogleGenAI({ apiKey })

const MODEL = 'gemini-3.5-flash-lite'
const CHUNK_SIZE = 12000
const CHUNK_OVERLAP = 500
const MAX_TEXT_LENGTH = 1200000
const JOBS_DIR = path.join(process.cwd(), 'jobs')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// --------------------------------------------------
// Gemini request queue: one request at a time
// --------------------------------------------------

let lastGeminiRequestAt = 0
let geminiQueue = Promise.resolve()

async function generateWithRetry(prompt) {
  const maxAttempts = 6

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const elapsed = Date.now() - lastGeminiRequestAt
    const wait = Math.max(0, 4500 - elapsed)

    if (wait > 0) await sleep(wait)

    lastGeminiRequestAt = Date.now()

    try {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: prompt
      })

      const result = response.text?.trim()

      if (!result) {
        throw new Error('Gemini returned an empty response')
      }

      return result

    } catch (error) {
      const message = String(error?.message || error)
      const status = error?.status || error?.code
      const statusCode = Number(status)

      const isRateLimit =
        statusCode === 429 ||
        message.includes('RESOURCE_EXHAUSTED') ||
        message.includes('429')

      const isUnavailable =
        statusCode === 503 ||
        String(status).toUpperCase() === 'UNAVAILABLE' ||
        message.includes('UNAVAILABLE') ||
        message.includes('503')

      const isTemporary = isRateLimit || isUnavailable

      if (!isTemporary || attempt === maxAttempts) {
        throw error
      }

      const retryMatch =
        message.match(/retry in ([0-9.]+)s/i) ||
        message.match(/retryDelay["']?\s*:\s*["']([0-9.]+)s/i)

      let delay

      if (retryMatch) {
        delay = Math.ceil(Number(retryMatch[1]) * 1000) + 1500
      } else if (isRateLimit) {
        delay = 35000 * attempt
      } else {
        delay = Math.min(8000 * (2 ** (attempt - 1)), 60000)
      }

      delay += Math.floor(Math.random() * 2000)

      console.log(
        `Gemini ${isRateLimit ? '429' : '503'}. Retry ${attempt}/${maxAttempts} after ${Math.ceil(delay / 1000)} seconds`
      )

      await sleep(delay)
    }
  }

  throw new Error('Gemini request failed after retries')
}

function generate(prompt) {
  const request = geminiQueue.then(
    () => generateWithRetry(prompt)
  )

  geminiQueue = request.catch(() => {})
  return request
}

// --------------------------------------------------
// PDF text processing
// --------------------------------------------------

function splitIntoChunks(text) {
  const chunks = []
  let start = 0

  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length)

    if (end < text.length) {
      const boundary = text.lastIndexOf('\n', end)

      if (boundary > start + CHUNK_SIZE * 0.6) {
        end = boundary
      } else {
        const space = text.lastIndexOf(' ', end)

        if (space > start + CHUNK_SIZE * 0.6) {
          end = space
        }
      }
    }

    const chunk = text.slice(start, end).trim()

    if (chunk) chunks.push(chunk)

    if (end >= text.length) break

    start = Math.max(start + 1, end - CHUNK_OVERLAP)
  }

  return chunks
}

function findRelevantChunks(chunks, question, maxChunks = 6) {
  const stopWords = new Set([
    'what', 'when', 'where', 'which', 'who', 'why', 'how',
    'the', 'and', 'for', 'from', 'with', 'that', 'this',
    'are', 'was', 'were', 'have', 'has', 'does',
    'ما', 'ماذا', 'متى', 'أين', 'كيف', 'لماذا',
    'من', 'عن', 'في', 'على', 'إلى', 'هذا', 'هذه',
    'هو', 'هي', 'هل', 'ماهي', 'ماهو'
  ])

  const terms = question
    .toLowerCase()
    .match(/[\p{L}\p{N}]{2,}/gu) || []

  const keywords = [...new Set(
    terms.filter(term => !stopWords.has(term))
  )]

  if (keywords.length === 0) {
    return chunks.slice(0, maxChunks)
  }

  const ranked = chunks.map((chunk, index) => {
    const normalized = chunk.toLowerCase()
    let score = 0

    for (const keyword of keywords) {
      let position = 0

      while ((position = normalized.indexOf(keyword, position)) !== -1) {
        score++
        position += keyword.length
      }
    }

    return { index, score, chunk }
  })

  const selected = ranked
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxChunks)
    .sort((a, b) => a.index - b.index)

  return selected.length
    ? selected.map(item => item.chunk)
    : chunks.slice(0, maxChunks)
}

// --------------------------------------------------
// Persistent job storage
// --------------------------------------------------

const jobs = new Map()
let jobQueue = []
let processingQueue = false

function jobFile(id) {
  return path.join(JOBS_DIR, id, 'job.json')
}

async function saveJob(job) {
  job.updatedAt = new Date().toISOString()

  const directory = path.join(JOBS_DIR, job.id)
  await fs.mkdir(directory, { recursive: true })

  const destination = jobFile(job.id)
  const temporary = destination + '.tmp'

  await fs.writeFile(
    temporary,
    JSON.stringify(job),
    'utf8'
  )

  await fs.rename(temporary, destination)
}

function publicJob(job) {
  return {
    id: job.id,
    task: job.task,
    language: job.language,
    status: job.status,
    phase: job.phase,
    totalChunks: job.totalChunks,
    completedChunks: job.completedChunks,
    progress: job.totalChunks
      ? Math.round(job.completedChunks / job.totalChunks * 100)
      : 0,
    answer: job.status === 'completed' ? job.answer : null,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  }
}

async function restoreJobs() {
  await fs.mkdir(JOBS_DIR, { recursive: true })

  const entries = await fs.readdir(JOBS_DIR, {
    withFileTypes: true
  })

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    try {
      const file = path.join(JOBS_DIR, entry.name, 'job.json')
      const content = await fs.readFile(file, 'utf8')
      const job = JSON.parse(content)

      if (!job.id || job.id !== entry.name) continue

      if (job.status === 'running' || job.status === 'queued') {
        job.status = 'queued'
        job.error = null
        jobs.set(job.id, job)
        jobQueue.push(job.id)
        await saveJob(job)

        console.log(`Restored job: ${job.id}`)
      } else {
        jobs.set(job.id, job)
      }
    } catch (error) {
      console.error(
        `Could not restore job ${entry.name}:`,
        error.message
      )
    }
  }

  console.log(`Restored ${jobQueue.length} pending jobs`)
}

// --------------------------------------------------
// Resumable job processing
// --------------------------------------------------

async function runJob(job) {
  const chunks = splitIntoChunks(job.text)

  job.totalChunks = chunks.length
  job.completedChunks = job.chunkResults.length
  await saveJob(job)

  if (job.task === 'chat') {
    if (!job.answer) {
      job.phase = 'answering'
      await saveJob(job)

      const relevantChunks = findRelevantChunks(
        chunks,
        job.question,
        6
      )

      job.answer = await generate(`
Answer the user's question using only the supplied document sections.

Answer language: ${job.language}.

User question:
${job.question}

Document sections:
${relevantChunks.map((chunk, index) =>
  `Section ${index + 1}:\n${chunk}`
).join('\n\n')}

Instructions:
- Answer accurately using the document.
- Do not invent facts.
- If the supplied sections do not contain the answer, say that the available document sections do not provide enough information.
- Explain your reasoning briefly when useful.
`)

      await saveJob(job)
    }

    return
  }

  const instruction = job.task === 'summarize'
    ? 'Summarize this document section. Extract its important facts, ideas, names, dates and conclusions. Be concise but preserve important details.'
    : 'Explain this document section clearly and thoroughly. Preserve important technical details, definitions, relationships and examples.'

  // Process only chunks that have not been saved yet.
  job.phase = 'processing'
  await saveJob(job)

  for (let i = job.chunkResults.length; i < chunks.length; i++) {
    console.log(`Job ${job.id}: chunk ${i + 1}/${chunks.length}`)

    const result = await generate(`
${instruction}

Answer language: ${job.language}.

Section ${i + 1} of ${chunks.length}:

${chunks[i]}

Keep the result focused on information actually present in this section.
`)

    job.chunkResults.push(result)
    job.completedChunks = job.chunkResults.length

    // Save immediately after every completed chunk.
    await saveJob(job)
  }

  // Restore or initialize the merge state.
  if (!job.mergeState) {
    job.mergeState = {
      current: [...job.chunkResults],
      next: [],
      index: 0,
      level: 1
    }
    await saveJob(job)
  }

  job.phase = 'merging'
  await saveJob(job)

  // Save each merge group so it can resume after interruption.
  while (job.mergeState.current.length > 8) {
    const state = job.mergeState

    if (state.index >= state.current.length) {
      state.current = state.next
      state.next = []
      state.index = 0
      state.level++
      await saveJob(job)
      continue
    }

    const group = state.current.slice(
      state.index,
      state.index + 8
    )

    console.log(
      `Job ${job.id}: merging level ${state.level}, group ${Math.floor(state.index / 8) + 1}`
    )

    const merged = await generate(`
Combine the following intermediate document notes into one coherent set of notes.

Answer language: ${job.language}.

Preserve important facts, figures, names, dates, conclusions and technical details.
Remove repetition but do not invent information.

${group.map((item, index) =>
  `Note ${index + 1}:\n${item}`
).join('\n\n')}

Keep the result concise and informative.
`)

    state.next.push(merged)
    state.index += 8
    await saveJob(job)
  }

  if (!job.answer) {
    job.phase = 'finalizing'
    await saveJob(job)

    const finalInstruction = job.task === 'summarize'
      ? 'Create a comprehensive final summary of the document.'
      : 'Create a clear, organized explanation of the entire document.'

    job.answer = await generate(`
${finalInstruction}

Answer language: ${job.language}.

Use the following intermediate notes from the document:

${job.mergeState.current.map((item, index) =>
  `Part ${index + 1}:\n${item}`
).join('\n\n')}

Organize the answer with headings and bullet points when useful.
Use only information supported by these notes.
`)

    await saveJob(job)
  }
}

async function drainJobQueue() {
  if (processingQueue) return

  processingQueue = true

  try {
    while (jobQueue.length > 0) {
      const id = jobQueue.shift()
      const job = jobs.get(id)

      if (!job || job.status !== 'queued') continue

      try {
        job.status = 'running'
        job.error = null
        await saveJob(job)

        console.log(`Starting job ${job.id}`)

        await runJob(job)

        job.status = 'completed'
        job.phase = 'completed'
        await saveJob(job)

        console.log(`Completed job ${job.id}`)

      } catch (error) {
        const message = String(error?.message || error)
        const status = error?.status || error?.code
        const statusCode = Number(status)

        const isTemporary =
          statusCode === 429 ||
          statusCode === 503 ||
          message.includes('RESOURCE_EXHAUSTED') ||
          message.includes('UNAVAILABLE') ||
          message.includes('429') ||
          message.includes('503')

        if (isTemporary && (job.retryCount || 0) < 3) {
          job.retryCount = (job.retryCount || 0) + 1
          job.status = 'queued'
          job.phase = 'queued'
          job.error = message

          await saveJob(job)

          console.log(
            `Job ${job.id}: temporary Gemini error. Automatic retry ${job.retryCount}/3 in 60 seconds.`
          )

          setTimeout(() => {
            if (job.status === 'queued') {
              enqueueJob(job)
            }
          }, 60000)

        } else {
          console.error(`Job ${job.id} failed:`, message)

          job.status = 'failed'
          job.error = message
          await saveJob(job)
        }
      }
    }
  } finally {
    processingQueue = false

    if (jobQueue.length > 0) {
      void drainJobQueue()
    }
  }
}

function enqueueJob(job) {
  if (!jobQueue.includes(job.id)) {
    jobQueue.push(job.id)
  }

  void drainJobQueue()
}

// --------------------------------------------------
// API routes
// --------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'MultiPDF AI Backend',
    model: MODEL,
    processing: 'persistent-jobs',
    queuedJobs: jobQueue.length
  })
})

// Create a background job.
app.post('/api/jobs', async (req, res) => {
  try {
    const { text, task, language, question } = req.body

    if (!text || typeof text !== 'string') {
      return res.status(400).json({
        error: 'PDF text is required'
      })
    }

    if (text.length > MAX_TEXT_LENGTH) {
      return res.status(413).json({
        error: `Document exceeds ${MAX_TEXT_LENGTH} characters`
      })
    }

    if (!['summarize', 'explain', 'chat'].includes(task)) {
      return res.status(400).json({
        error: 'Invalid task'
      })
    }

    if (task === 'chat' && (!question || !question.trim())) {
      return res.status(400).json({
        error: 'Please enter a question'
      })
    }

    const now = new Date().toISOString()

    const job = {
      id: randomUUID(),
      task,
      language: language || 'Arabic',
      question: task === 'chat' ? question.trim() : '',
      text,
      status: 'queued',
      phase: 'queued',
      totalChunks: 0,
      completedChunks: 0,
      chunkResults: [],
      mergeState: null,
      retryCount: 0,
      answer: null,
      error: null,
      createdAt: now,
      updatedAt: now
    }

    jobs.set(job.id, job)
    await saveJob(job)
    enqueueJob(job)

    res.status(202).json({
      success: true,
      job: publicJob(job)
    })

  } catch (error) {
    console.error('Job creation failed:', error.message)
    res.status(500).json({
      error: 'Could not create the processing job'
    })
  }
})

// List saved jobs.
app.get('/api/jobs', (req, res) => {
  const result = [...jobs.values()]
    .sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    )
    .map(publicJob)

  res.json({
    success: true,
    jobs: result
  })
})

// Get job status and completed answer.
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id)

  if (!job) {
    return res.status(404).json({
      error: 'Job not found'
    })
  }

  res.json({
    success: true,
    job: publicJob(job)
  })
})

// Retry a failed job without losing completed chunks.
app.post('/api/jobs/:id/retry', async (req, res) => {
  const job = jobs.get(req.params.id)

  if (!job) {
    return res.status(404).json({
      error: 'Job not found'
    })
  }

  if (job.status !== 'failed') {
    return res.status(409).json({
      error: 'Only failed jobs can be retried'
    })
  }

  job.status = 'queued'
  job.phase = 'queued'
  job.retryCount = 0
  job.error = null

  await saveJob(job)
  enqueueJob(job)

  res.status(202).json({
    success: true,
    job: publicJob(job)
  })
})

// Legacy synchronous endpoint, retained temporarily
// for compatibility with the existing frontend.
app.post('/api/ai', async (req, res) => {
  try {
    const { text, task, language, question } = req.body

    if (!text || typeof text !== 'string') {
      return res.status(400).json({
        error: 'PDF text is required'
      })
    }

    if (text.length > MAX_TEXT_LENGTH) {
      return res.status(413).json({
        error: `Document exceeds ${MAX_TEXT_LENGTH} characters.`
      })
    }

    if (!['summarize', 'explain', 'chat'].includes(task)) {
      return res.status(400).json({
        error: 'Invalid task'
      })
    }

    if (task === 'chat' && (!question || !question.trim())) {
      return res.status(400).json({
        error: 'Please enter a question'
      })
    }

    const answerLanguage = language || 'Arabic'
    const chunks = splitIntoChunks(text)
    let answer

    if (task === 'chat') {
      const relevantChunks = findRelevantChunks(
        chunks,
        question,
        6
      )

      answer = await generate(`
Answer the user's question using only the supplied document sections.

Answer language: ${answerLanguage}.

User question:
${question}

Document sections:
${relevantChunks.map((chunk, index) =>
  `Section ${index + 1}:\n${chunk}`
).join('\n\n')}

Instructions:
- Answer accurately using the document.
- Do not invent facts.
- If the supplied sections do not contain the answer, say that the available document sections do not provide enough information.
`)
    } else {
      const results = []

      for (let i = 0; i < chunks.length; i++) {
        const instruction = task === 'summarize'
          ? 'Summarize this document section. Preserve important details.'
          : 'Explain this document section clearly and thoroughly.'

        results.push(await generate(`
${instruction}

Answer language: ${answerLanguage}.

Section ${i + 1} of ${chunks.length}:

${chunks[i]}
`))
      }

      let current = results

      while (current.length > 8) {
        const next = []

        for (let i = 0; i < current.length; i += 8) {
          const group = current.slice(i, i + 8)

          next.push(await generate(`
Combine these document notes. Preserve important details and remove repetition.
Answer language: ${answerLanguage}.

${group.map((item, index) =>
  `Note ${index + 1}:\n${item}`
).join('\n\n')}
`))
        }

        current = next
      }

      answer = await generate(`
${task === 'summarize'
  ? 'Create a comprehensive final summary of the document.'
  : 'Create a clear, organized explanation of the entire document.'}

Answer language: ${answerLanguage}.

${current.map((item, index) =>
  `Part ${index + 1}:\n${item}`
).join('\n\n')}
`)
    }

    res.json({
      success: true,
      answer,
      processing: {
        method: 'chunked',
        totalChunks: chunks.length
      }
    })

  } catch (error) {
    console.error('AI request failed:', error.message)

    res.status(500).json({
      error: 'AI processing failed. Check Gemini availability, API quota and network connection.'
    })
  }
})

// --------------------------------------------------
// Start server and restore interrupted jobs
// --------------------------------------------------

async function startServer() {
  await restoreJobs()

  const PORT = process.env.PORT || 3001

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`MultiPDF AI Backend listening on port ${PORT}`)
    console.log(`AI Model: ${MODEL}`)
    console.log('Persistent background jobs enabled')
  })

  if (jobQueue.length > 0) {
    void drainJobQueue()
  }
}

startServer().catch(error => {
  console.error('Backend startup failed:', error)
  process.exit(1)
})
