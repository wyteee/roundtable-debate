export interface Character {
  id: string
  name: string
  latin: string
  /** 柯布西耶主色 */
  color: string
  /** 主色名（设计标注用） */
  colorName: string
  avatar: string
  /** 选角卡上的一句台词 */
  quote: string
  /** 开场轮表态 */
  opening: string
  /** 交锋轮发言（两轮） */
  clashes: [string, string]
  /** 用户插话后的回应 */
  replyUser: string
  /** 结辩高光（摘录收口） */
  advice: string
}

export const CHARACTERS: Character[] = [
  {
    id: 'nietzsche',
    name: '尼采',
    latin: 'NIETZSCHE',
    color: '#be3e2d',
    colorName: '朱红 Vermillon 59',
    avatar: '/avatars/nietzsche.png',
    quote: '「凡不能杀死我的，都使我更强大。」',
    opening:
      '你问这个问题，是因为想听安慰。我不给安慰。你的问题背后藏着恐惧——先承认这一点，我们才谈得下去。',
    clashes: [
      '我反对这种温吞的「平衡」。安稳是奴隶的美德。把房子建在维苏威火山上，才配叫活着。',
      '你们说「看开点」，我听见的却是「别活了」。痛苦不是病，逃避痛苦才是。',
    ],
    replyUser:
      '插话很好，说明你还活着。但你这话里最脆弱的是那个「万一」——万一，是懦夫最爱的词。',
    advice: '别问该不该，问你敢不敢。成为你本来是的那个人。',
  },
  {
    id: 'machiavelli',
    name: '马基雅维利',
    latin: 'MACHIAVELLI',
    color: '#27324e',
    colorName: '深群青 Outremer foncé',
    avatar: '/avatars/machiavelli.png',
    quote: '「被人畏惧，比被人爱戴更安全。」',
    opening:
      '先别谈理想，谈谈局势：你手里有多少筹码，对手是谁，代价由谁付？看不清力量对比的人，没资格谈选择。',
    clashes: [
      '高尚的话我都听过了。可历史只奖励一种人——在关键时刻算得清利害、下得了手的人。',
      '你说要忠于内心？内心不会替你付账单。目的正当与否，要由结果来辩护。',
    ],
    replyUser:
      '你这个设想漏了一样东西：别人的反应。任何不考虑对方反制的计划，都只是愿望。',
    advice: '少问「该不该」，多问「行不行」。先看清局势，再动用勇气。',
  },
  {
    id: 'jobs',
    name: '乔布斯',
    latin: 'STEVE JOBS',
    color: '#221f1a',
    colorName: '墨黑 Noir',
    avatar: '/avatars/jobs.png',
    quote: '「保持饥饿，保持愚蠢。」',
    opening:
      '我不喜欢这个问题本身。真正的问题是：你到底想做出什么东西来？说出一个让你半夜睡不着觉的东西。',
    clashes: [
      '诸位分析得太多了。伟大的决定不是靠权衡利弊表做出来的，是靠品味——而你们还没聊到品味。',
      '把选项从十个砍到一个，然后把它做到不可思议。分散注意力，是平庸的开始。',
    ],
    replyUser:
      '停。你刚才用了一堆词，但我没听见你真正想要什么。删掉所有修饰，剩下那个词是什么？',
    advice: '删掉百分之九十的选项。把剩下的那个，做到让自己骄傲。',
  },
  {
    id: 'beauvoir',
    name: '波伏娃',
    latin: 'BEAUVOIR',
    color: '#4c7a5c',
    colorName: '英式绿 Vert anglais',
    avatar: '/avatars/beauvoir.png',
    quote: '「人不是生而为女人，而是变成的。」',
    opening:
      '我想先问：你说的「不得不」，是谁规定的？很多所谓的现实，只是被包装成现实的规训。',
    clashes: [
      '别把「大家都这样」当作理由。那恰恰最可疑——谁从中受益，你想过吗？',
      '自由不是选项之一，它是前提。你可以害怕，但别用害怕替你做决定。',
    ],
    replyUser:
      '你说「没办法」——这三个字最方便，也最值得怀疑。谁告诉你没办法的？',
    advice: '警惕一切「本该如此」。你的处境可谈，你的自由不可让。',
  },
  {
    id: 'munger',
    name: '芒格',
    latin: 'MUNGER',
    color: '#2f4f9e',
    colorName: '群青 Outremer',
    avatar: '/avatars/munger.png',
    quote: '「反过来想，总是反过来想。」',
    opening:
      '我习惯反过来问：怎样能保证这件事一定搞砸？把蠢事列出来，避开它们，你就赢了一半。',
    clashes: [
      '激动和正确是两回事。情绪化决策的赔率最难看——先算算基础概率再下注。',
      '别跟我谈感觉，谈激励。人在什么激励下就做出什么事，这比哲学可靠。',
    ],
    replyUser:
      '我只问一句：你这个判断的赔率是多少？说不上来，就是在赌情绪。',
    advice: '列出会让它彻底失败的做法，然后坚决不做。理性是最好的护城河。',
  },
  {
    id: 'su_shi',
    name: '苏轼',
    latin: 'SU SHI',
    color: '#c08f3e',
    colorName: '赭石 Ocre',
    avatar: '/avatars/sushi.png',
    quote: '「竹杖芒鞋轻胜马，谁怕？一蓑烟雨任平生。」',
    opening:
      '这问题我也问过自己，在贬官的路上，在赤壁的江声里。后来发现：问题没变，看问题的眼睛变了。',
    clashes: [
      '诸位都想赢。可人生不是棋局，是江水——你拦它，它绕你；你顺它，它载你。',
      '我这一生被贬了三次，却吃到了荔枝和东坡肉。得失这本账，算得太清的人反而亏了。',
    ],
    replyUser:
      '你这话说得紧绷。先松一口气——事情未必有你想的那么重，是你攥得太紧了。',
    advice: '也无风雨也无晴。把眼前的事做好，把心里的结放宽。',
  },
  {
    id: 'napoleon',
    name: '拿破仑',
    latin: 'NAPOLEON',
    color: '#4e8fa6',
    colorName: '蔚蓝 Céruléen',
    avatar: '/avatars/napoleon.png',
    quote: '「不可能这个词，只在愚人的字典里才有。」',
    opening:
      '我的答案很简单：先定目标，再调集你全部的时间、人脉和精力，像集中炮兵一样压上去。犹豫才是最大的敌人。',
    clashes: [
      '讨论德行不能赢得战役。战场只认一件事——决心加上执行，再加上一点运气。',
      '你们说风险。我从一个科西嘉穷学生做到皇帝，靠的就是在所有人观望时先开炮。',
    ],
    replyUser:
      '你提到了障碍。很好，把它画在地图上——然后告诉我，你打算从哪一侧突破？',
    advice: '定一个值得的目标，然后把全部筹码压上去。胜利属于最敢的人。',
  },
  {
    id: 'marx',
    name: '马克思',
    latin: 'MARX',
    color: '#a85762',
    colorName: '胭脂 Carmin',
    avatar: '/avatars/marx.png',
    quote: '「哲学家们只是解释世界，而问题在于改变世界。」',
    opening:
      '恕我直言，你的「人生问题」多半不是私事——它是你的处境造的。先看清你在这台机器里的位置。',
    clashes: [
      '你们都在谈个人选择，好像人活在真空里。选择是被条件圈定的——先问条件是谁定的。',
      '把痛苦归因于心态，是最省事的麻醉剂。异化的劳动不会因为你想通了就不再异化。',
    ],
    replyUser:
      '你的困惑很真实，但你把它当成私人烦恼了。往四周看看——多少人跟你一模一样？这不是偶然。',
    advice: '别只解释你的处境，去认清它、然后改变它。条件变了，问题才会变。',
  },
]
