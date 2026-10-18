document.addEventListener('alpine:init', () => {
  Alpine.data('storeApp', () => ({
    mode: new URLSearchParams(location.search).get('state') === 'register' ? 'register' : 'login',
    email: '', password: '', nickname: '', showPassword: false, remember: false, busy: false,
    copied: false, copiedPreview: '', selectedSkill: null, legal: null, authOpen: false, toast: { visible: false, title: '', message: '' },
    toastTimer: null, returnFocus: null,
    init() {
      try { this.email = localStorage.getItem('huanyu-remembered-email') || ''; this.remember = !!this.email; } catch (_) { /* Storage may be disabled. */ }
      this.$watch('selectedSkill', () => this.updateModal());
      this.$watch('legal', () => this.updateModal());
      this.$watch('authOpen', () => this.updateModal());
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { this.closeModal(); return; }
        if (event.key !== 'Tab' || (!this.selectedSkill && !this.legal && !this.authOpen)) return;
        const dialog = this.selectedSkill || this.legal ? this.$refs.dialog : this.$refs.authDialog;
        const items = Array.from(dialog.querySelectorAll('button, a[href], input, [tabindex="0"]')).filter(el => el.getClientRects().length && !el.disabled && el.tabIndex >= 0);
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      });
      const state = new URLSearchParams(location.search).get('state');
      if (state === 'register' || state === 'login') this.authOpen = true;
      if (state === 'done') this.notify('登录交互已完成', '这是 PoC 演示反馈，尚未连接账户与授权服务。');
    },
    openAuth(mode = 'login') {
      if (!this.authOpen && !this.selectedSkill && !this.legal) this.returnFocus = document.activeElement;
      this.selectedSkill = null; this.legal = null;
      this.mode = mode; this.showPassword = false; this.authOpen = true;
      this.$nextTick(() => this.$refs.authDialog.focus());
    },
    switchMode(mode, focus = false) {
      if (this.busy) return;
      this.mode = mode; this.showPassword = false;
      if (focus) this.$nextTick(() => document.getElementById('tab-' + mode).focus());
    },
    notify(title, message) {
      clearTimeout(this.toastTimer);
      this.toast = { visible: true, title, message };
      this.toastTimer = setTimeout(() => { this.toast.visible = false; }, 6500);
    },
    async submit() {
      if (this.busy) return;
      this.busy = true;
      const mode = this.mode;
      try {
        if (this.remember && mode === 'login') localStorage.setItem('huanyu-remembered-email', this.email);
        else localStorage.removeItem('huanyu-remembered-email');
      } catch (_) { this.notify('无法记住邮箱', '浏览器未允许本地存储，你仍可继续体验登录。'); }
      await new Promise(resolve => setTimeout(resolve, 850));
      this.busy = false;
      this.notify(mode === 'login' ? '登录交互已完成' : '注册交互已完成', '这是 PoC 演示反馈，尚未连接账户与授权服务。');
    },
    async socialLogin() {
      if (this.busy) return;
      this.busy = true;
      await new Promise(resolve => setTimeout(resolve, 600));
      this.busy = false;
      this.notify('GitHub 登录演示', '交互已就绪；正式登录需接入 GitHub OAuth 服务。');
    },
    forgotPassword() {
      const email = document.getElementById('email');
      if (!email.value || !email.checkValidity()) { email.reportValidity(); email.focus(); return; }
      this.notify('找回密码', '已验证邮箱格式；PoC 未发送邮件，正式上线后将接入重置服务。');
    },
    async copyCommands() {
      try {
        await navigator.clipboard.writeText('npx hy login --token <授权码>\nnpx hy install <skill>');
        this.copied = true; this.notify('安装指令已复制', '将占位符替换为你的授权码与技能名称后，在终端运行。');
        setTimeout(() => { this.copied = false; }, 2500);
      } catch (_) { this.notify('复制未完成', '浏览器未授予剪贴板权限，请选中终端里的两行指令手动复制。'); }
    },
    async copyPreview(id) {
      const output = document.querySelector('[data-preview="' + id + '"]');
      if (!output) return;
      try {
        await navigator.clipboard.writeText(output.innerText);
        this.copiedPreview = id;
        setTimeout(() => { if (this.copiedPreview === id) this.copiedPreview = ''; }, 2500);
      } catch (_) {
        this.notify('复制未完成', '请选中交付稿中的文字，手动复制。');
      }
    },
    openSkill(name) {
      const skill = (window.HUANYU_SKILLS || []).find(item => item.id === name && item.listed);
      if (!skill) return;
      this.returnFocus = document.activeElement;
      this.selectedSkill = { ...skill, name: skill.id };
    },
    updateModal() {
      const open = !!(this.selectedSkill || this.legal || this.authOpen);
      if (open && !this.returnFocus) this.returnFocus = document.activeElement;
      document.body.style.overflow = open ? 'hidden' : '';
      document.querySelector('.page-frame').inert = open;
      if (open) this.$nextTick(() => (this.selectedSkill || this.legal ? this.$refs.dialog : this.$refs.authDialog).focus());
    },
    closeModal() {
      if (this.legal && this.authOpen) { this.legal = null; this.$nextTick(() => this.$refs.authDialog.focus()); return; }
      if (!this.selectedSkill && !this.legal && !this.authOpen) return;
      this.selectedSkill = null; this.legal = null;
      this.authOpen = false;
      this.$nextTick(() => { this.returnFocus?.focus(); this.returnFocus = null; });
    }
  }));
  Alpine.data('skillCatalog', () => ({
    items: window.HUANYU_SKILLS || [], query: '', category: '全部', expanded: '', limit: 8,
    init() {
      const requested = new URLSearchParams(location.search).get('preview');
      if (this.items.some(item => item.listed && item.id === requested)) this.expanded = requested;
      this.$watch('query', () => { this.limit = 8; this.expanded = ''; });
    },
    get categories() {
      return ['全部', ...new Set(this.items.filter(item => item.listed).map(item => item.category))];
    },
    get filtered() {
      const query = this.query.trim().toLocaleLowerCase();
      return this.items.filter(item => item.listed
        && (this.category === '全部' || item.category === this.category)
        && (!query || [item.id, item.title, item.description, item.category, ...(item.keywords || [])]
          .join(' ').toLocaleLowerCase().includes(query)));
    },
    get visible() { return this.filtered.slice(0, this.limit); },
    selectCategory(category) { this.category = category; this.limit = 8; this.expanded = ''; },
    clearFilters() { this.query = ''; this.selectCategory('全部'); },
    toggle(id) { this.expanded = this.expanded === id ? '' : id; }
  }));
});

document.addEventListener('DOMContentLoaded', () => {
  if (!window.gsap || !window.ScrollTrigger) return;
  gsap.registerPlugin(ScrollTrigger);
  gsap.matchMedia().add('(prefers-reduced-motion: no-preference)', () => {
    gsap.from('.hero-type > *', { y: 13, opacity: 0, duration: .7, stagger: .09, ease: 'power3.out', clearProps: 'all' });
    gsap.from('.hero-art img', { scale: 1.04, duration: 1.2, ease: 'power3.out' });
    gsap.to('.hero-art img', { y: 60, scale: .9, opacity: .5, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
    gsap.utils.toArray('.skill-catalog').forEach((element) => {
      gsap.from(element, { y: 15, duration: .45, ease: 'power3.out', scrollTrigger: { trigger: element, start: 'top 93%', once: true }, clearProps: 'all' });
    });
    gsap.from('.license-body', { y: 12, duration: .4, ease: 'power3.out', scrollTrigger: { trigger: '.acquisition', start: 'top 93%', once: true }, clearProps: 'all' });
  });
});

