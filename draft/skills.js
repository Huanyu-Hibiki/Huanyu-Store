// 商品目录的唯一数据源。新增商品无需复制页面或为详情另写一份配置。
// listed 控制前台展示；这不是订单、支付或后台上架服务。
window.HUANYU_SKILLS = [
  {
    id: 'founder-ip', title: '创始人 IP 战略', category: '品牌与定位', listed: true,
    description: '梳理经验、受众与内容主线，建立可以持续执行的个人 IP 战略。',
    keywords: ['品牌', '定位', '创始人', '受众', '个人 IP'],
    editions: ['开源基础版', '专业授权'],
    preview: {
      inputLabel: '示例输入', input: '做了六年品牌设计，想开始做个人内容。',
      note: '从经历里辨认优势，把优势放到读者需要的位置。',
      outputLabel: '定位简报示例', title: ['帮小预算的创业者，', '做好品牌的第一步。'],
      paragraphs: ['读者是第一次建立品牌、预算有限的创业者。', '内容主线：定位判断、视觉取舍、亲手做过的项目复盘。']
    }
  },
  {
    id: 'oracle-bone', title: '内容校准', category: '内容与表达', listed: true,
    description: '校准读者、语境与表达，让内容给出具体、可执行的建议。',
    keywords: ['写作', '文章', '改写', '内容', '表达', '校准'],
    editions: ['开源基础版', '专业授权'],
    preview: {
      inputLabel: '原文示例', input: '专业品牌设计，帮助创业者提升商业价值。',
      note: '明确读者与具体处境，把宽泛的承诺换成可执行的下一步。',
      outputLabel: '校准成稿示例', title: ['预算只有一万，', '别急着做 Logo。'],
      paragraphs: ['先写下一句话：你的产品，为谁解决什么问题。', '找五位潜在客户读一遍。别急着解释，先听他们怎么理解。', '确认表达有效，再把钱花在视觉设计上。']
    }
  },
  {
    id: 'pulsehub', title: '获客闭环', category: '增长与获客', listed: true,
    description: '连接内容触达、线索识别与转化跟进，推进有方向的需求对话。',
    keywords: ['获客', '增长', '线索', '转化', '跟进', '对话'],
    editions: ['开源基础版', '专业授权'],
    preview: {
      inputLabel: '读者回应示例', input: '我预算也只有一万，应该先做什么？',
      note: '先了解问题，再进入方案，让一次回应成为清楚的需求。',
      outputLabel: '沟通准备示例', title: ['先说说你的产品，', '为谁解决什么问题？'],
      paragraphs: ['继续确认产品与受众、预算与时间、当前卡点。', '需求匹配后，整理沟通纪要与方案范围。']
    }
  }
];
