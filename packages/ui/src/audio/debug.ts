// 开发期排查用：记录最近一次实际播放的音频。
//
// 音频不像界面那样能用 DOM 观察到，所以把「刚刚播了什么」记在这里，
// dev 模式下通过控制台的 __sgsAudio.last 查看：
//   __sgsAudio.last
//   → { action: 'sha-fire', seat: 's1', gender: 'male',
//       sfx: 'sha-fire-1', voice: 'sha-fire-m', heroVoice: 'zhouyu/反间' }
// 生产构建不挂到 window，这个对象也不会被读。
export const lastPlayed: {
  /** 触发这次声音的动作（日志里的 action） */
  action: string | null;
  /** 动作来自哪个座次 */
  seat: string | null;
  /** 该座次角色的性别（决定用男声还是女声） */
  gender: 'male' | 'female' | null;
  /** 实际播的音效文件/合成音名；null 表示这次没播音效 */
  sfx: string | null;
  /** 实际播的语音文件名；null 表示没有对应语音 */
  voice: string | null;
  /** 实际播的**武将语音**（`<武将id>/<技能名>`）；null 表示这次没有 */
  heroVoice: string | null;
} = { action: null, seat: null, gender: null, sfx: null, voice: null, heroVoice: null };
