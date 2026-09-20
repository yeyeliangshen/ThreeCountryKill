// 临时探针：两格都能满足的候选 → 第二问的 prompt 里有没有选项
import { applyIntent, configFromPreset, createGame, emptyFlags, getHero, toSnapshot } from '../packages/engine/src';

const seats = ['s0','s1','s2','s3','s4','s5'].map((id) => ({ seatId: id, name: id, heroId: 'vanilla' }));
const state = createGame(seats, 'T', { mode: 'guozhan', freePick: true, config: configFromPreset('full2026') });
state.draft = null;
const at = (id: string) => state.players.find((p) => p.seatId === id)!;
for (const s of state.seatOrder) {
  const p = at(s);
  p.heroId = 'vanilla'; p.deputyHeroId = 'vanilla';
  p.faction = 'wei'; p.heroRevealed = true; p.deputyRevealed = true;
  p.maxHp = 4; p.hp = 4; p.hand = []; p.flags = emptyFlags();
}
// 召唤者：曹洪（魏，鹤翼＝队列型，已明置）
const a = at('s0');
a.heroId = 'caohong'; a.faction = 'wei'; a.heroRevealed = true; a.deputyRevealed = true;
// 候选：隔壁 s1，**两张牌都是魏**（→ 两格都够格 → 会问「明置哪一张」）
const b = at('s1');
b.heroId = 'caocao'; b.deputyHeroId = 'xiahoudun'; b.faction = 'wei';
b.heroRevealed = false; b.deputyRevealed = false;
// 其他人设成非魏，保证只有 s1 够格
for (const s of ['s2','s3','s4','s5']) { const p = at(s); p.faction = 'shu'; }
state.turn = { seatIndex: 0, phase: 'play' };
state.pending = { kind: 'play', seatId: 's0' };

const r = applyIntent(state, 's0', { type: 'useSkill', skillId: 'zhenfa_summon', targetIds: [] });
console.log('发起结果:', r.ok ? 'ok' : r.error, '| pending =', state.pending ? state.pending.kind : null);
const p1 = toSnapshot(state, 's1').prompt;
console.log('候选看到的第 1 问:', p1?.kind, '|', p1?.message, '| 选项:', JSON.stringify(p1?.choiceOptions ?? null));
applyIntent(state, 's1', { type: 'chooseOption', optionId: 'yes' });
const p2 = toSnapshot(state, 's1').prompt;
console.log('候选看到的第 2 问:', p2?.kind, '|', p2?.message, '| 选项:', JSON.stringify(p2?.choiceOptions ?? null));
console.log('pending 明细:', JSON.stringify(state.pending));
