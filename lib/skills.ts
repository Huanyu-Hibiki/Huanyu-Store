export interface Skill {
 id: string; title: string; category: string; listed: boolean; description: string;
 keywords: string[]; editions: string[];
 preview: { inputLabel: string; input: string; note: string; outputLabel: string; title: string[]; paragraphs: string[] };
}
// 商品目录的唯一数据源。新增商品无需复制页面或为详情另写一份配置。
// listed 控制前台展示；这不是订单、支付或后台上架服务。
export const skills: Skill[] = [
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
    id: 'github-renovation', title: 'GitHub 装修', category: '品牌与定位', listed: true,
    description: '为开源项目编写专业 README、搭建同名 profile 主页，并优化仓库元数据与 SEO。',
    keywords: ['GitHub', 'README', '开源', 'profile', '主页', 'SEO'],
    editions: ['开源基础版', '专业授权'],
    preview: {
      inputLabel: '示例输入', input: '这是一个开源了半年的 CLI 工具，README 只有安装说明。',
      note: '把仓库的门面当产品打磨：先定读者，再定结构。',
      outputLabel: '装修清单示例', title: ['让过路的开发者', '三秒看懂这个仓库。'],
      paragraphs: ['诊断 README、profile 与仓库元数据三块门面的缺失。', '产出：结构化 README、同名 profile 主页与 description/topics 优化。']
    }
  },
  {
    id: 'ppt-design', title: 'PPT 设计', category: '内容与表达', listed: true,
    description: '通过确认的版式设计生成可编辑 PPTX：先访谈或吸收素材、确认设计，再产出成品演示文稿。',
    keywords: ['PPT', '演示文稿', 'PPTX', '幻灯片', '汇报', 'deck'],
    editions: ['开源基础版', '专业授权'],
    preview: {
      inputLabel: '示例输入', input: '下周要给投资人做 15 页的路演演示，素材是这份业务备忘录。',
      note: '先确认 PPTDESIGN.md 版式，再进生成——不返工。',
      outputLabel: '交付示例', title: ['版式先对齐，', '成稿可编辑。'],
      paragraphs: ['访谈或吸收素材，产出可确认的版式设计稿。', '按确认稿生成 PPTX：图表、表格与备注保持为原生对象。']
    }
  },
  {
    id: 'skill-master', title: 'Skill 全生命周期管理', category: 'Agent 工程', listed: true,
    description: '盘点已装 skill、安全扫描第三方 skill、分析开源 skill、从零编写与迭代优化，五合一合集路由器。',
    keywords: ['skill', '扫描', '安全', '编写', '优化', '盘点', 'Agent'],
    editions: ['开源基础版', '专业授权'],
    preview: {
      inputLabel: '示例输入', input: '帮我看看装过的 skill 里哪些重复了，再给这个新想法写一个。',
      note: '五件事各由一个子 skill 承担：盘点、扫描、分析、编写、优化。',
      outputLabel: '路由示例', title: ['从装进来、看懂它，', '到写出来、养得好。'],
      paragraphs: ['sm-manager 盘点现状，sm-security 扫描第三方风险。', 'sm-analyzer 拆解开源实现，sm-writer 与 sm-optimizer 负责写与养。']
    }
  },
  {
    id: 'shendu-yuedu', title: '深度阅读', category: '学习与知识', listed: true,
    description: '六个子 skill 组成阅读闭环：初始化知识库、节级别精读目录、锚定问题预读、常青知识卡片、实践转化与技能迭代。',
    keywords: ['深度阅读', '拆书', '读书笔记', '知识卡片', '精读', '阅读转化'],
    editions: ['开源基础版', '专业授权'],
    preview: {
      inputLabel: '示例输入', input: '这本 500 页的书，我只想吸收能用在业务里的三分之一。',
      note: 'AI 只做结构化提炼，不代写原始笔记。',
      outputLabel: '阅读闭环示例', title: ['一本书读进去，', '留下一库常青卡片。'],
      paragraphs: ['节级别目录先分 P0 必读与 P3 跳过，时间花在刀刃上。', '卡片沉淀为 Wiki，再萃取成可验收的个人技能库。']
    }
  },
  {
    id: 'video-production-workflow', title: '视频制作管线', category: '内容与表达', listed: true,
    description: '终稿文稿、原始拍摄、字幕、剪映草稿、外部素材与 B-roll 生成串成一条可追踪的制作管线。',
    keywords: ['视频', '制作', '剪映', '字幕', 'B-roll', '分镜', '粗剪'],
    editions: ['开源基础版', '专业授权'],
    preview: {
      inputLabel: '示例输入', input: '文稿已经定稿，拍了一些素材，帮我串成一条能追踪进度的制作线。',
      note: '从真实任务、失败和用户纠正中验证式优化制作流。',
      outputLabel: '管线示例', title: ['每个环节有状态，', '每条素材可追踪。'],
      paragraphs: ['规划分镜与粗剪，字幕校对后合成成片。', '生成 B-roll 与剪映草稿，状态随时可查。']
    }
  },
  {
    id: 'xianyu-skill', title: '闲鱼虚拟商品运营', category: '增长与获客', listed: true,
    description: '商品详情图、高转化描述与爆款拆解的闲鱼虚拟商品运营工作流合集。',
    keywords: ['闲鱼', '详情图', '商品描述', '爆款', '拆解', '虚拟商品'],
    editions: ['开源基础版', '专业授权'],
    preview: {
      inputLabel: '示例输入', input: '我要上架一份 AI 资料包，帮我做封面和详情页文案。',
      note: '先出 3 版风格让用户选，再进高转化文案。',
      outputLabel: '上架物料示例', title: ['封面、详情、话术，', '一次备齐可上架。'],
      paragraphs: ['01 生成合规详情图：1:1 封面加竖版轮播。', '02 三版标题与爆款结构正文，附禁词自检。', '03 拆解同赛道爆款，输出可迁移要素。']
    }
  }
];
