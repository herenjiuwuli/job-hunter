import { Router } from 'express'
import { readJSON } from '../lib/store.js'
import { scoreResumeVsJd } from '../lib/matcher.js'

const router = Router()

// GET /api/match?resumeId=xxx
// 把简历与所有「带了 JD 的投递记录」逐一打分，按匹配分降序返回
router.get('/api/match', async (req, res) => {
  const { resumeId } = req.query
  if (!resumeId) return res.status(400).json({ error: '请先选择简历' })

  const resumes = (await readJSON('resumes')) || []
  const resume = resumes.find((r) => r.id === resumeId)
  if (!resume) return res.status(404).json({ error: '简历不存在' })

  const apps = (await readJSON('applications')) || []
  const scored = apps
    .filter((a) => String(a.jd || '').trim())
    .map((a) => {
      const { score, matched, jdKeywords } = scoreResumeVsJd(resume, a.jd)
      return {
        id: a.id,
        company: a.company,
        jobTitle: a.jobTitle,
        platform: a.platform,
        score,
        matched,
        jdKeywords,
      }
    })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))

  res.json(scored)
})

export default router
