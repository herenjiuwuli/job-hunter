/**
 * stages.js 纯函数单测（不依赖后端、不依赖浏览器）
 *
 * 为什么单独测这两个函数：
 *   parseStage 决定「平台文案认不认得出」，shouldAdvance 决定「认出来之后敢不敢写」。
 *   这两处错了不会报错，只会让漏斗数字悄悄偏，接口测试很难发现。
 *
 * 跑：node scripts/test-stage.mjs
 */
import { parseStage, shouldAdvance, stageFromStatus, highestNormalStage, pushHistory, STAGES } from '../server/lib/stages.js'
import { needsMyAction, isActive } from '../src/stages.js'

let pass = 0
let fail = 0

function eq(actual, expect, name) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect)
  if (ok) {
    pass++
  } else {
    fail++
    console.log(`  ❌ ${name}：期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(actual)}`)
  }
}

function ok(cond, name) {
  eq(Boolean(cond), true, name)
}

console.log('— 平台文案解析 —')
// 2026-11-05：回放真账本时 9 条一条都没推进，根因是这里只认中文别名。
// 扩展上报的 stage 是 key（submitted/viewed/screening/written），必须原样认。
eq(parseStage('viewed'), 'viewed', 'stage key 本身要认（扩展上报的就是它）')
eq(parseStage('screening'), 'screening', 'screening key')
eq(parseStage('written'), 'written', 'written key')
eq(parseStage('submitted'), 'submitted', 'submitted key')
eq(parseStage(''), null, '空串 = 没采到，不能瞎猜')
eq(parseStage('已投递'), 'submitted', '已投递')
eq(parseStage('待查看'), 'submitted', '待查看 → 还没被看，仍算已投递')
eq(parseStage('简历被查看'), 'viewed', '简历被查看')
eq(parseStage('HR 已查看'), 'viewed', '带前后缀也能认')
eq(parseStage('已读'), 'viewed', 'BOSS 已读')
eq(parseStage('初筛中'), 'screening', '初筛中')
eq(parseStage('复筛'), 'screening', '复筛')
eq(parseStage('已发笔试'), 'written', '笔试')
eq(parseStage('测评'), 'written', '测评也算笔试')
eq(parseStage('约面试'), 'interview', '面试')
eq(parseStage('已录用'), 'offer', '录用')
eq(parseStage('offer'), 'offer', '小写 offer')
eq(parseStage('不合适'), 'rejected', '不合适')
eq(parseStage('未通过'), 'rejected', '未通过')
eq(parseStage('已结束'), 'rejected', '已结束')
eq(parseStage(''), null, '空串不猜')
eq(parseStage(null), null, 'null 不猜')
eq(parseStage('今天天气不错'), null, '无关文案不猜')
// 已知边界：解析是「包含即命中」，所以长句里的「面试」也会中。
// 采集端因此必须先做「整串等于状态词」的过滤，不能把整段正文丢进来。
eq(parseStage('面试经验丰富'), 'interview', '长文本子串会命中（采集端必须整串过滤）')
eq(parseStage('  '), null, '空白不猜')

console.log('— 只前进（权重规则）—')
ok(shouldAdvance(null, 'submitted'), '首次直接写')
ok(shouldAdvance('submitted', 'viewed'), '正常推进')
ok(shouldAdvance('viewed', 'interview'), '可跨阶段推进')
ok(!shouldAdvance('interview', 'viewed'), '不能回退')
ok(!shouldAdvance('interview', 'interview'), '同阶段不重复写')
ok(shouldAdvance('interview', 'rejected'), '面试后不合格（8>5）')
ok(shouldAdvance('rejected', 'offer'), '判过不合格又给 offer（9>8）')
ok(!shouldAdvance('offer', 'rejected'), '已录用不被不合格盖掉')
ok(!shouldAdvance('viewed', null), '没采到阶段不写')
ok(!shouldAdvance(null, null), '两边都空不写')
ok(!shouldAdvance('submitted', 'unknown_key'), '未知 key 不写（防御脏数据）')

console.log('— 人工 status → 初始 stage —')
eq(stageFromStatus('待投递'), null, '草稿没有 stage')
eq(stageFromStatus('已投递'), 'submitted', '已投递')
eq(stageFromStatus('已沟通'), 'viewed', '已沟通最多算被查看，不往高猜')
eq(stageFromStatus('已面试'), 'interview', '已面试')
eq(stageFromStatus('已offer'), 'offer', '已offer')
eq(stageFromStatus('已拒绝'), 'rejected', '已拒绝')
eq(stageFromStatus('已淘汰'), 'rejected', '已淘汰')
eq(stageFromStatus('不存在'), null, '未知状态不猜')

console.log('— 漏斗到达数辅助 —')
eq(highestNormalStage([]), null, '空历史')
eq(highestNormalStage([{ stage: 'submitted' }, { stage: 'screening' }]), 'screening', '取最高正常阶段')
eq(highestNormalStage([{ stage: 'interview' }, { stage: 'rejected' }]), 'interview', '不合格不参与排名')
eq(highestNormalStage(['viewed', 'written']), 'written', '兼容纯字符串历史')

console.log('— 历史去重 —')
eq(pushHistory([], 'submitted').length, 1, '首条')
eq(pushHistory([{ stage: 'submitted' }], 'submitted').length, 1, '连续相同不重复记')
eq(pushHistory([{ stage: 'submitted' }], 'viewed').length, 2, '阶段变化才记')

console.log('— 权重完整性（改常量时别漏）—')
for (const [key, s] of Object.entries(STAGES)) {
  ok(typeof s.weight === 'number' && s.weight > 0, `${key} 有权重`)
  ok(typeof s.label === 'string' && s.label.length > 0, `${key} 有标签`)
}
ok(STAGES.offer.weight > STAGES.rejected.weight, 'offer 优先级高于 rejected（否则录用会被不合格盖掉）')
ok(STAGES.rejected.weight > STAGES.interview.weight, 'rejected 优先级高于 interview（面试后不合格要能写进去）')

console.log('— 待回复判据（只看来信，不看阶段推进） —')
// 真机样本（2026-10-30 惊叹科技）：我在聊天里说「不太适合我，祝您早日找到」——
// 这条不是被拒。如果只按 stage 判，它会永远挂在「待回复」里，每条都要人工看一眼才删得掉。
{
  // ⭐ 2026-11-06 主人纠正：「被查看 / 进初筛」不是待办。
  //    简历被点开、状态推进都不产生聊天消息，没有任何东西等我回。
  //    BOSS 上尤其明显：状态写着「初筛」，聊天框里一条消息都没有。
  eq(needsMyAction({ stage: 'viewed', awaitingReply: false }), false, '被查看 ≠ 要回复')
  eq(needsMyAction({ stage: 'screening', awaitingReply: false }), false, '进初筛 ≠ 要回复')
  eq(needsMyAction({ stage: 'viewed' }), false, '老数据没有来信字段 → 不提示（宁可漏报不虚报）')

  // 真正的判据：聊天框里对方是最后说话的一方
  eq(needsMyAction({ stage: 'viewed', awaitingReply: true }), true, '对方发了消息且我没回 → 提示')
  eq(needsMyAction({ stage: 'interview', awaitingReply: true }), true, '面试阶段来信一样提示')
  eq(needsMyAction({ stage: 'viewed', awaitingReply: false }), false, '我回完了就消（允许回落）')

  const givenUp = { stage: 'viewed', awaitingReply: true, withdrawnAt: '2026-10-30T19:59:00.000Z' }
  eq(needsMyAction(givenUp), false, '我放弃的不算「待回复」')
  eq(isActive(givenUp), false, '我放弃的不算「进行中」')
  eq(needsMyAction({ stage: 'rejected', awaitingReply: true, withdrawnAt: '' }), false, '不合格不用回')
  eq(isActive({ stage: 'viewed' }), true, '被查看仍是进行中')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
