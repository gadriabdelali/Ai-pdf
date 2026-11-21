import { useEffect, useRef, useState } from 'react'
import {
  BookOpen, Files, MessageSquare, Settings, Plus,
  Upload, Search, Trash2, FileText, Languages,
  Sparkles, Menu, X, Bot
} from 'lucide-react'
import './App.css'
import { db } from './db'
import { extractPDFText } from './lib/pdfReader'

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://127.0.0.1:3001'

type PDFFile = {
  id: number
  name: string
  size: string
  file: File
}

const languages = [
  { value: 'ar', label: 'العربية' },
  { value: 'fr', label: 'Français' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'it', label: 'Italiano' },
]

const providers = ['Gemini']

function App() {
  const [page, setPage] = useState('library')
  const [files, setFiles] = useState<PDFFile[]>([])
  const [search, setSearch] = useState('')
  const [language, setLanguage] = useState('ar')
  const [provider, setProvider] = useState('Gemini')
  const [selectedFile, setSelectedFile] = useState<PDFFile | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const [documentText, setDocumentText] = useState('')
  const [answer, setAnswer] = useState('')
  const [question, setQuestion] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const [readingPDF, setReadingPDF] = useState(false)
  const [activeJobId, setActiveJobId] = useState<string | null>(
    () => localStorage.getItem('multipdf-active-job')
  )
  const [activeJobFileId, setActiveJobFileId] = useState<string | null>(
    () => localStorage.getItem('multipdf-active-job-file')
  )
  const [jobProgress, setJobProgress] = useState(0)
  const [jobPhase, setJobPhase] = useState('')

  useEffect(() => {
    let active = true

    db.pdfs.orderBy('createdAt').reverse().toArray()
      .then(records => {
        if (!active) return

        setFiles(records.map(record => ({
          id: record.id!,
          name: record.name,
          size: record.size,
          file: new File([record.blob], record.name, {
            type: 'application/pdf'
          })
        })))
      })
      .catch(error => console.error('PDF database loading error:', error))

    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true

    async function readPDF() {
      if (!selectedFile) {
        setDocumentText('')
        setAiError('')
        setReadingPDF(false)
        return
      }

      setReadingPDF(true)
      setAiError('')

      if (activeJobFileId !== String(selectedFile.id)) {
        setAnswer('')
      }

      setDocumentText('')

      try {
        const text = await extractPDFText(selectedFile.file)

        if (!text.trim()) {
          throw new Error('لم يتم العثور على نص داخل ملف PDF. قد يكون الملف عبارة عن صور ويحتاج إلى OCR.')
        }

        if (active) setDocumentText(text)
      } catch (error) {
        if (active) {
          setAiError(
            error instanceof Error ? error.message : 'تعذر قراءة ملف PDF.'
          )
        }
      } finally {
        if (active) setReadingPDF(false)
      }
    }

    readPDF()

    return () => {
      active = false
    }
  }, [selectedFile, activeJobFileId])

  useEffect(() => {
    if (!activeJobId) return

    let cancelled = false

    async function monitorJob() {
      setAiLoading(true)

      while (!cancelled) {
        try {
          const response = await fetch(
            `${API_BASE_URL}/api/jobs/${activeJobId}`
          )

          if (!response.ok) {
            throw new Error('تعذر استرجاع حالة المهمة.')
          }

          const data = await response.json()

          if (!data.success || !data.job) {
            throw new Error(data.error || 'بيانات المهمة غير صالحة.')
          }

          const job = data.job

          if (cancelled) return

          setJobProgress(job.progress || 0)
          setJobPhase(job.phase || job.status || '')

          if (job.status === 'completed') {
            setAnswer(job.answer || 'لم يتم إرجاع إجابة.')
            setAiError('')
            setAiLoading(false)
            return
          }

          if (job.status === 'failed') {
            setAiError(job.error || 'فشلت معالجة المستند.')
            setAiLoading(false)
            return
          }

          await new Promise(resolve => setTimeout(resolve, 2000))
        } catch (error) {
          if (cancelled) return

          setAiError(
            error instanceof Error
              ? error.message
              : 'تعذر الاتصال بالخادم.'
          )

          await new Promise(resolve => setTimeout(resolve, 3000))
        }
      }
    }

    monitorJob()

    return () => {
      cancelled = true
    }
  }, [activeJobId])

  const uploadFiles = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files || [])
    const pdfs = selected.filter(file =>
      file.type === 'application/pdf' ||
      file.name.toLowerCase().endsWith('.pdf')
    )

    try {
      const newFiles: PDFFile[] = []

      for (const file of pdfs) {
        const size = (file.size / (1024 * 1024)).toFixed(2) + ' MB'
        const id = await db.pdfs.add({
          name: file.name,
          size,
          blob: file,
          createdAt: Date.now()
        })

        newFiles.push({ id, name: file.name, size, file })
      }

      setFiles(previous => [...newFiles, ...previous])
    } catch (error) {
      console.error('PDF saving error:', error)
      alert('تعذر حفظ الملف. تحقق من مساحة التخزين.')
    }

    event.target.value = ''
  }

  const deleteFile = async (id: number) => {
    try {
      await db.pdfs.delete(id)
      setFiles(previous => previous.filter(file => file.id !== id))
      if (selectedFile?.id === id) setSelectedFile(null)
    } catch (error) {
      console.error('PDF deletion error:', error)
      alert('تعذر حذف الملف من قاعدة البيانات.')
    }
  }

  const askAI = async (
    task: 'summarize' | 'explain' | 'chat'
  ) => {
    if (provider !== 'Gemini') {
      setAiError('محرك Gemini هو المحرك المتاح حالياً.')
      return
    }

    if (!selectedFile || !documentText.trim()) {
      setAiError('اختر ملف PDF وانتظر اكتمال قراءته.')
      return
    }

    if (documentText.length > 1200000) {
      setAiError('المستند طويل جداً. الحد الأقصى 1,200,000 حرف.')
      return
    }

    if (task === 'chat' && !question.trim()) {
      setAiError('اكتب سؤالك أولاً.')
      return
    }

    setAiLoading(true)
    setAiError('')
    setAnswer('')
    setJobProgress(0)
    setJobPhase('queued')

    try {
      const response = await fetch(`${API_BASE_URL}/api/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          task,
          text: documentText,
          language: languages.find(l => l.value === language)?.label || 'العربية',
          question: task === 'chat' ? question : ''
        })
      })

      const data = await response.json()

      if (!response.ok || !data.success || !data.job?.id) {
        throw new Error(data.error || 'تعذر إنشاء مهمة المعالجة.')
      }

      localStorage.setItem('multipdf-active-job', data.job.id)
      localStorage.setItem('multipdf-active-job-file', String(selectedFile.id))
      setActiveJobFileId(String(selectedFile.id))
      setActiveJobId(data.job.id)
    } catch (error) {
      setAiError(
        error instanceof Error ? error.message : 'تعذر الاتصال بالخادم.'
      )
      setAiLoading(false)
    }
  }

  const visibleFiles = files.filter(file =>
    file.name.toLowerCase().includes(search.toLowerCase())
  )

  const navigation = [
    { id: 'library', label: 'مكتبة PDF', icon: Files },
    { id: 'chat', label: 'المساعد الذكي', icon: MessageSquare },
    { id: 'settings', label: 'الإعدادات', icon: Settings },
  ]

  return (
    <div className="app-shell" dir="rtl">
      <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
        <div className="brand">
          <div className="brand-icon"><BookOpen size={25} /></div>
          <div>
            <h2>MultiPDF <span>AI</span></h2>
            <small>Your intelligent PDF library</small>
          </div>
          <button className="mobile-close" onClick={() => setMenuOpen(false)}><X /></button>
        </div>

        <button className="upload-button" onClick={() => inputRef.current?.click()}>
          <Plus size={19} /> إضافة ملف PDF
        </button>

        <input
          ref={inputRef}
          type="file"
          accept=".pdf,application/pdf"
          multiple
          hidden
          onChange={uploadFiles}
        />

        <div className="nav-title">القائمة الرئيسية</div>
        <nav className="navigation">
          {navigation.map(item => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                className={`nav-item ${page === item.id ? 'active' : ''}`}
                onClick={() => { setPage(item.id); setMenuOpen(false) }}
              >
                <Icon size={19} />
                <span>{item.label}</span>
                {item.id === 'library' && <span className="nav-count">{files.length}</span>}
              </button>
            )
          })}
        </nav>

        <div className="sidebar-bottom">
          <div className="ai-status"><span className="status-dot" /> جاهز للعمل</div>
          <div className="profile">
            <div className="profile-avatar">M</div>
            <div><strong>MultiPDF User</strong><small>Local workspace</small></div>
          </div>
        </div>
      </aside>

      {menuOpen && <div className="overlay" onClick={() => setMenuOpen(false)} />}

      <main className="main-area">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMenuOpen(true)}><Menu /></button>
          <div className="breadcrumb">MultiPDF AI <span>/</span> {
            navigation.find(item => item.id === page)?.label
          }</div>
          <div className="topbar-right">
            <span className="secure-label">مساحة عمل محلية</span>
            <div className="top-avatar">M</div>
          </div>
        </header>

        {page === 'library' && (
          <section className="content">
            <div className="welcome-row">
              <div>
                <div className="eyebrow"><Sparkles size={15} /> مكتبتك الذكية</div>
                <h1>مكتبة <span>PDF</span></h1>
                <p>اجمع مستنداتك، لخّصها، وتحدث معها بمساعدة الذكاء الاصطناعي.</p>
              </div>
              <button className="primary-button" onClick={() => inputRef.current?.click()}>
                <Upload size={18} /> تحميل PDF
              </button>
            </div>

            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-icon purple"><Files /></div>
                <div><small>إجمالي الملفات</small><strong>{files.length}</strong></div>
              </div>
              <div className="stat-card">
                <div className="stat-icon blue"><MessageSquare /></div>
                <div><small>المحرك المختار</small><strong className="stat-provider">{provider}</strong></div>
              </div>
              <div className="stat-card">
                <div className="stat-icon green"><Languages /></div>
                <div><small>لغة الإجابة</small><strong className="stat-provider">{languages.find(l => l.value === language)?.label}</strong></div>
              </div>
            </div>

            <div className="section-heading">
              <div><h2>ملفاتي</h2><p>إدارة مستندات PDF الخاصة بك</p></div>
              <div className="search-box">
                <Search size={17} />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="ابحث عن ملف..." />
              </div>
            </div>

            {visibleFiles.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon"><FileText size={38} /></div>
                <h3>{files.length === 0 ? 'مكتبتك فارغة حالياً' : 'لا توجد نتائج'}</h3>
                <p>{files.length === 0 ? 'ابدأ بإضافة أول ملف PDF إلى مكتبتك.' : 'جرّب البحث باسم آخر.'}</p>
                {files.length === 0 && (
                  <button className="primary-button" onClick={() => inputRef.current?.click()}>
                    <Upload size={18} /> اختر ملف PDF
                  </button>
                )}
              </div>
            ) : (
              <div className="file-grid">
                {visibleFiles.map(file => (
                  <div className="file-card" key={file.id}>
                    <div className="file-card-top">
                      <div className="pdf-icon"><FileText size={25} /></div>
                      <button className="delete-button" title="حذف الملف" onClick={() => deleteFile(file.id)}>
                        <Trash2 size={17} />
                      </button>
                    </div>
                    <h3 title={file.name}>{file.name}</h3>
                    <p>{file.size}</p>
                    <button className="open-file" onClick={() => { setSelectedFile(file); setPage('chat') }}>
                      <MessageSquare size={16} /> اسأل عن هذا الملف
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {page === 'chat' && (
          <section className="content">
            <div className="welcome-row">
              <div>
                <div className="eyebrow"><Sparkles size={15} /> AI Assistant</div>
                <h1>المساعد <span>الذكي</span></h1>
                <p>تحدث مع مستنداتك واحصل على إجابات بلغتك المفضلة.</p>
              </div>
            </div>

            <div className="chat-settings">
              <label>الملف المختار
                <select value={selectedFile?.id ?? ''} onChange={e => setSelectedFile(files.find(f => String(f.id) === e.target.value) || null)}>
                  <option value="">اختر ملف PDF</option>
                  {files.map(file => <option key={file.id} value={file.id}>{file.name}</option>)}
                </select>
              </label>
              <label>محرك AI
                <select value={provider} onChange={e => setProvider(e.target.value)}>
                  {providers.map(p => <option key={p}>{p}</option>)}
                </select>
              </label>
              <label>لغة الإجابة
                <select value={language} onChange={e => setLanguage(e.target.value)}>
                  {languages.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
                </select>
              </label>
            </div>

            <div className="chat-placeholder">
              <div className="chat-robot"><Bot size={35} /></div>
              <h2>مساعدك لقراءة المستندات</h2>
              <p>{selectedFile ? `تم اختيار: ${selectedFile.name}` : 'اختر ملف PDF من مكتبتك للبدء.'}</p>

              {readingPDF && <p>جارٍ قراءة ملف PDF...</p>}

              {selectedFile && !readingPDF && documentText && (
                <p>تمت قراءة المستند بنجاح. عدد الأحرف: {documentText.length}</p>
              )}

              {selectedFile && documentText && (
                <div className="ai-actions" style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center', marginTop: '20px' }}>
                  <button
                    className="primary-button"
                    disabled={aiLoading || readingPDF}
                    onClick={() => askAI('summarize')}
                  >
                    <Sparkles size={17} /> تلخيص المستند
                  </button>

                  <button
                    className="primary-button"
                    disabled={aiLoading || readingPDF}
                    onClick={() => askAI('explain')}
                  >
                    <BookOpen size={17} /> شرح المستند
                  </button>
                </div>
              )}

              {selectedFile && documentText && (
                <form
                  onSubmit={event => {
                    event.preventDefault()
                    askAI('chat')
                  }}
                  style={{ width: '100%', maxWidth: '650px', margin: '24px auto 0', textAlign: 'right' }}
                >
                  <label htmlFor="pdf-question">اكتب سؤالك حول المستند</label>
                  <textarea
                    id="pdf-question"
                    value={question}
                    onChange={event => setQuestion(event.target.value)}
                    placeholder="مثال: ما أهم الأفكار في هذا المستند؟"
                    rows={3}
                    disabled={aiLoading}
                    style={{ display: 'block', width: '100%', marginTop: '10px', padding: '12px', borderRadius: '10px', resize: 'vertical' }}
                  />
                  <button
                    type="submit"
                    className="primary-button"
                    disabled={aiLoading || !question.trim()}
                    style={{ marginTop: '12px' }}
                  >
                    <MessageSquare size={17} /> إرسال السؤال
                  </button>
                </form>
              )}

              {aiLoading && (
                <div style={{ width: '100%', maxWidth: '650px', margin: '20px auto' }}>
                  <p>Gemini يعالج المستند... {jobProgress}%</p>
                  <div style={{
                    width: '100%',
                    height: '10px',
                    background: 'rgba(128,128,128,0.2)',
                    borderRadius: '10px',
                    overflow: 'hidden'
                  }}>
                    <div style={{
                      width: `${jobProgress}%`,
                      height: '100%',
                      background: '#6c63ff',
                      transition: 'width 0.4s ease'
                    }} />
                  </div>
                  <small style={{ display: 'block', marginTop: '8px' }}>
                    المرحلة: {jobPhase || 'في الانتظار'}
                  </small>
                </div>
              )}

              {aiError && (
                <div role="alert" style={{ color: '#ff7777', marginTop: '20px', whiteSpace: 'pre-wrap' }}>
                  {aiError}
                </div>
              )}

              {answer && selectedFile && (
                (!activeJobFileId || activeJobFileId === String(selectedFile.id))
              ) && (
                <div className="ai-answer" style={{ width: '100%', maxWidth: '800px', margin: '24px auto 0', padding: '20px', textAlign: 'right', borderRadius: '12px', whiteSpace: 'pre-wrap', lineHeight: '1.9' }}>
                  <h3>إجابة Gemini</h3>
                  <p>{answer}</p>
                </div>
              )}

              {!selectedFile && (
                <div className="coming-soon">
                  <Sparkles size={16} /> اختر ملف PDF من القائمة للبدء.
                </div>
              )}
            </div>
          </section>
        )}

        {page === 'settings' && (
          <section className="content">
            <div className="welcome-row">
              <div><div className="eyebrow"><Settings size={15} /> التخصيص</div><h1>الإعدادات</h1><p>تحكم في محرك الذكاء الاصطناعي ولغة الإجابة.</p></div>
            </div>
            <div className="settings-panel">
              <h2>إعدادات الذكاء الاصطناعي</h2>
              <label>مزود الذكاء الاصطناعي
                <select value={provider} onChange={e => setProvider(e.target.value)}>
                  {providers.map(p => <option key={p}>{p}</option>)}
                </select>
              </label>
              <label>لغة الإجابة الافتراضية
                <select value={language} onChange={e => setLanguage(e.target.value)}>
                  {languages.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
                </select>
              </label>
              <div className="local-notice"><span className="status-dot" /> ملفاتك تدار محلياً، ومحرك Gemini متصل بالخادم المحلي.</div>
            </div>
          </section>
        )}

        <footer className="footer">MultiPDF AI <span>•</span> Intelligent document workspace</footer>
      </main>
    </div>
  )
}

export default App
