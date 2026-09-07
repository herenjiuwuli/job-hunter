const $ = (s) => document.querySelector(s)

function log(msg) {
  $('#log').textContent = msg
}

async function refreshQuota() {
  try {
    const q = await chrome.runtime.sendMessage({ action: 'getQuota' })
    $('#quota').textContent = `${q.used} / ${q.limit}`
  } catch {
    $('#quota').textContent = '-'
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab || !tab.id) throw new Error('未找到当前标签页')
  return tab
}

async function apply() {
  const greeting = $('#greeting').value
  const autoClick = $('#autoClick').checked
  log('投递中…')
  try {
    const tab = await activeTab()
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'apply', greeting, autoClick })
    if (res && res.ok) {
      const mode = res.autoClicked ? '已自动点击投递' : '已填好打招呼语，请手动点投递按钮'
      log(`✅ ${res.company} · ${res.jobTitle}\n${mode}（今日 ${res.used}/${res.limit}）`)
    } else {
      log(`❌ ${(res && res.error) || '执行失败'}`)
    }
  } catch (e) {
    log('❌ 请先打开「实习僧 / BOSS 直聘」的岗位投递页，再点此按钮')
  }
  refreshQuota()
}

async function inspect() {
  log('探测中…')
  try {
    const tab = await activeTab()
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'inspect' })
    $('#inspectOut').textContent = JSON.stringify(res, null, 2)
    log('已获取页面结构，展开下方「页面结构」查看')
  } catch (e) {
    log('❌ 请先打开「实习僧 / BOSS 直聘」页面')
  }
}

document.getElementById('applyBtn').addEventListener('click', apply)
document.getElementById('inspectBtn').addEventListener('click', inspect)
document.getElementById('resetBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'resetQuota' })
  refreshQuota()
})

// 防封配置：仅投 BOSS 活跃岗位 + 关键词黑名单
async function initFilters() {
  const { bossActiveOnly = false, filterKeywords = '' } = await chrome.storage.local.get(['bossActiveOnly', 'filterKeywords'])
  $('#bossActiveOnly').checked = !!bossActiveOnly
  $('#filterKeywords').value = filterKeywords
}
$('#bossActiveOnly').addEventListener('change', () => {
  chrome.storage.local.set({ bossActiveOnly: $('#bossActiveOnly').checked })
})
$('#filterKeywords').addEventListener('change', () => {
  chrome.storage.local.set({ filterKeywords: $('#filterKeywords').value })
})
initFilters()

refreshQuota()
