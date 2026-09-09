/* ============================================================
   工具函数
   ============================================================ */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const IS_MOBILE_VIEW = window.matchMedia('(max-width: 768px)').matches;

function scrollToSection(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY - 80;
  if (window.WheelDamp) window.WheelDamp.scrollTo(top);
  else window.scrollTo({ top, behavior: 'smooth' });
}

/* ============================================================
   滚轮滚动阻尼（桌面端整页平滑滚动）
   - 只拦截 wheel：鼠标滚轮 / 触控板双指；触屏（pointer: coarse）保留原生惯性
   - 阻尼系数：每帧向目标位置收敛 15%（按帧时长归一化，帧率无关）
   - 内部滚动容器（AI 对话抽屉等）自动放行
   - rAF 循环仅在滚动未到位时运行，空闲零占用
   ============================================================ */
(function initWheelDamp() {
  if (matchMedia('(pointer: coarse)').matches) return; // 手机/平板走原生滚动
  const DAMP = 0.15;              // 阻尼强度：每帧残余 15%，可调（越小越"跟手"，越大越绵）
  let target = window.scrollY, current = target, raf = 0, lastT = 0;

  const maxScroll = () => document.documentElement.scrollHeight - window.innerHeight;

  // 命中内部可滚动容器（overflow-y: auto/scroll 且可滚）时不劫持
  function insideScrollable(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight) return true;
    }
    return false;
  }

  function loop(now) {
    const dt = Math.min(now - lastT, 64);
    lastT = now;
    current += (target - current) * (1 - Math.pow(1 - DAMP, dt / 16.667));
    window.scrollTo(0, current);
    if (Math.abs(target - current) < 0.1) { current = target; window.scrollTo(0, current); raf = 0; return; }
    raf = requestAnimationFrame(loop);
  }

  function kick() {
    if (!raf) { current = window.scrollY; target = Math.max(0, Math.min(target, maxScroll())); lastT = performance.now(); raf = requestAnimationFrame(loop); }
  }

  window.addEventListener('wheel', (e) => {
    // 二维码灯箱打开时锁定滚轮，不让页面阻尼滑动
    if (document.getElementById('qrLightbox')?.style.display === 'flex') return;
    if (insideScrollable(e.target)) return;
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= window.innerHeight;
    target = Math.max(0, Math.min(target + dy, maxScroll()));
    kick();
  }, { passive: false });

  // 滚动条拖动 / 键盘翻页等原生滚动：同步内部状态
  window.addEventListener('scroll', () => { if (!raf) current = target = window.scrollY; }, { passive: true });

  // 本模块接管平滑滚动，关闭 CSS scroll-behavior 以免逐帧写入被浏览器二次平滑
  document.documentElement.style.scrollBehavior = 'auto';

  // 对外 API：导航锚点等程序化滚动也走同一套阻尼
  window.WheelDamp = { scrollTo(y) { target = Math.max(0, Math.min(y, maxScroll())); kick(); } };
})();

/* ============================================================
   Splash：按设备执行媒体资源门禁 + 点击进入
   - 桌面端：壁纸、音频、图片、视频全部达到可展示/可连续播放状态后才放行
   - 移动端：预载背景图、背景视频与主页面视频；普通图片、音频及兴趣弹层视频保持懒加载
   - 不用伪时间进度，也不因超时跳过；失败项留在启动页并允许重试
   ============================================================ */
(function initSplash() {
  const splash = $('#splash'), bar = $('#loadBar'), enter = splash.querySelector('.enter');
  const pctEl = $('#loadPct'), statusEl = $('#loadStatus');
  // Splash（loading）期间锁定滚动：overflow 兜底 + 捕获阶段拦截滚轮/触摸/键盘滚动
  // （捕获阶段执行并 stopImmediatePropagation，避免先注册的 WheelDamp 阻尼模块累积滚动目标导致进入后跳位）
  document.body.style.overflow = 'hidden';
  const scrollLock = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  const keyLock = (e) => {
    if ([' ', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
      e.preventDefault(); e.stopImmediatePropagation();
    }
  };
  window.addEventListener('wheel', scrollLock, { capture: true, passive: false });
  window.addEventListener('touchmove', scrollLock, { capture: true, passive: false });
  window.addEventListener('keydown', keyLock, { capture: true });

  let ready = false, entered = false, loading = false;
  let failedUrls = [];

  // 桌面端预载音频；移动端保持默认静音，并等用户主动开启时才请求音频。
  const audio = $('#bgm');
  primeBgVideo();
  if (IS_MOBILE_VIEW) {
    audio.preload = 'none';
    audio.removeAttribute('src');
    $('#noteIndicator').classList.add('off');
    $('#audioToggle').setAttribute('aria-pressed', 'false');
    $('#audioToggle').setAttribute('aria-label', '背景音乐：已暂停，点击播放');
  } else {
    audio.src = './src/assets/audio/bgm-low.mp3';
    audio.preload = 'auto';
    audio.load();
  }

  // 等本文件后续的同步初始化完成（轮播、证书墙、隐藏弹层均已生成 DOM）再扫描。
  setTimeout(loadAllAssets, 0);

  enter.addEventListener('click', () => {
    if (ready) enterSite();
    else if (!loading && failedUrls.length) loadAllAssets();
  });

  function absoluteUrl(src) {
    try { return new URL(src, document.baseURI).href; } catch (_) { return src; }
  }

  function waitForImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const done = () => {
        const decoded = img.decode ? img.decode().catch(() => {}) : Promise.resolve();
        decoded.then(() => resolve(src));
      };
      img.onload = done;
      img.onerror = () => reject(new Error(src));
      img.src = src;
      if (img.complete) img.naturalWidth ? done() : reject(new Error(src));
    });
  }

  function waitForMedia(el, src) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        el.removeEventListener('canplaythrough', pass);
        el.removeEventListener('error', fail);
        ok ? resolve(src) : reject(new Error(src));
      };
      const pass = () => finish(true);
      const fail = () => finish(false);
      // 超时只报告失败并留在启动页，不会绕过资源门禁。
      const timer = setTimeout(fail, networkTier() === 'poor' ? 90000 : 45000);
      el.addEventListener('canplaythrough', pass, { once: true });
      el.addEventListener('error', fail, { once: true });
      el.preload = 'auto';
      if (el.dataset.src) {
        el.src = el.dataset.src;
        el.dataset.loaded = '1';
      } else if (!el.getAttribute('src')) {
        el.src = src;
      }
      if (el.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) finish(true);
      else el.load();
    });
  }

  async function loadAllAssets() {
    if (loading || entered) return;
    loading = true; ready = false; failedUrls = [];
    splash.classList.remove('ready', 'has-error');
    enter.classList.remove('ready', 'retry');
    enter.textContent = '加载中…';
    bar.style.width = '0%'; pctEl.textContent = '0%';

    if (!IS_MOBILE_VIEW) {
      // 桌面端把延迟地址恢复为真实 src，再由下方门禁统一预载和解码。
      document.querySelectorAll('img[data-src]').forEach((img) => {
        img.src = img.dataset.src;
        img.dataset.loaded = '1';
        img.loading = 'eager';
      });
      document.querySelectorAll('img[src]').forEach((img) => { img.loading = 'eager'; });
    }
    const imageUrls = new Set();
    if (IS_MOBILE_VIEW) {
      // 移动端只把全屏背景图纳入首屏门禁，其余图片交给原生 lazy loading。
      const bgPoster = $('#bgVideo')?.getAttribute('poster')?.trim();
      if (bgPoster) imageUrls.add(absoluteUrl(bgPoster));
    } else {
      document.querySelectorAll('img[src]').forEach((img) => {
        const src = img.getAttribute('src').trim();
        if (src) imageUrls.add(absoluteUrl(src));
      });
      document.querySelectorAll('video[poster]').forEach((video) => {
        const poster = video.getAttribute('poster').trim();
        if (poster) imageUrls.add(absoluteUrl(poster));
      });
    }

    const mediaByUrl = new Map();
    const mediaSelector = IS_MOBILE_VIEW ? 'video[src], video[data-src]' : 'video[src], video[data-src], audio[src]';
    document.querySelectorAll(mediaSelector).forEach((el) => {
      // 移动端的四个兴趣视频在用户打开弹层时才加载，不占用启动阶段流量。
      if (IS_MOBILE_VIEW && el.closest('#hobbyModal')) return;
      const raw = el.dataset.src || el.getAttribute('src');
      if (raw) mediaByUrl.set(absoluteUrl(raw), el);
    });

    const tasks = [
      ...[...imageUrls].map((url) => ({ url, run: () => waitForImage(url) })),
      ...[...mediaByUrl].map(([url, el]) => ({ url, run: () => waitForMedia(el, url) })),
    ];
    let finished = 0;
    const update = () => {
      const pct = tasks.length ? Math.round((finished / tasks.length) * 100) : 100;
      bar.style.width = pct + '%'; pctEl.textContent = pct + '%';
      statusEl.textContent = `正在加载 ${finished} / ${tasks.length} 项资源`;
    };
    update();
    const results = await Promise.allSettled(tasks.map(async (task) => {
      try { return await task.run(); }
      finally { finished += 1; update(); }
    }));
    failedUrls = results.flatMap((result, i) => result.status === 'rejected' ? [tasks[i].url] : []);
    loading = false;
    if (failedUrls.length) {
      splash.classList.add('has-error');
      const failedNames = failedUrls.map((url) => {
        try { return decodeURIComponent(new URL(url).pathname.split('/').pop()); }
        catch (_) { return url; }
      }).join('、');
      statusEl.textContent = `${failedUrls.length} 项资源加载失败：${failedNames}，请重试`;
      enter.textContent = '重试加载';
      enter.classList.add('retry');
      console.error('启动资源加载失败：', failedUrls);
      return;
    }
    ready = true;
    statusEl.textContent = `全部 ${tasks.length} 项资源已就绪`;
    enter.textContent = '点击进入';
    enter.classList.add('ready');
    splash.classList.add('ready');
  }

  function enterSite() {
    if (entered) return;
    entered = true;
    // 解除 loading 期间的滚动锁定
    window.removeEventListener('wheel', scrollLock, { capture: true });
    window.removeEventListener('touchmove', scrollLock, { capture: true });
    window.removeEventListener('keydown', keyLock, { capture: true });
    document.body.style.overflow = '';
    splash.classList.add('hidden');
    window.__entered = true;
    scheduleBgVideo();
    bgmPlay(); // 音频已预加载，点击手势下立即出声
  }
})();

/* ============================================================
   背景视频：本地 mp4 循环（首选） + 远程 MUX HLS 流（兜底，hls.js / Safari 原生）
   - 本地化原因（跨浏览器兼容）：远程 stream.mux.com 会被 Chrome 端广告拦截类
     扩展按拦截规则静默拦截（Edge 无扩展故正常），且受 DNS/CDN 可达性影响；
     本地相对路径资源不受任何扩展/网络环境影响，各浏览器行为完全一致。
   - 启动页期间预加载背景视频，用户点击进入后立即播放；视频尚未出帧时使用 CSS 动态底景。
   ============================================================ */
var __bgVideoStarted; // var 而非 let：initSplash 同步调用本函数时避免 TDZ
var __bgVideoScheduled;
var __bgVideoPrimed;
var __bgNeedHls; // 本地视频缺失时置位，等待 hls.js 就绪后走远程兜底
function primeBgVideo() {
  if (__bgVideoPrimed) return;
  const video = $('#bgVideo');
  if (!video) return;
  __bgVideoPrimed = true;
  video.muted = true; video.defaultMuted = true;
  video.playsInline = true; video.preload = 'auto'; video.loop = true;
  video.addEventListener('playing', () => video.classList.add('is-playing'));
  video.addEventListener('error', () => { __bgNeedHls = true; loadHlsWhenNeeded(() => tryStartHls(video)); }, { once: true });
  video.src = './src/assets/media/bg-loop.mp4';
  video.load();
}
// 在“点击进入”的同一用户手势内播放；部分移动浏览器会拦截延迟到下一轮事件循环的播放请求。
function scheduleBgVideo() {
  if (__bgVideoScheduled) return;
  __bgVideoScheduled = true;
  initBgVideo();
  __bgVideoScheduled = false;
}
function initBgVideo() {
  if (__bgVideoStarted) return;
  const video = $('#bgVideo');
  if (!video) return;
  __bgVideoStarted = true;
  primeBgVideo();
  const tryPlay = () => video.play().catch(() => {});
  video.addEventListener('loadeddata', tryPlay, { once: true });
  video.load();
  tryPlay();
  // 播放看门狗：视频意外暂停（自动播放被拦、标签页节流后未恢复等）时自动续播，
  // 保证 Splash 的“动画动起来才显示按钮”判定不被卡住（本地循环与 HLS 兜底共用）
  setInterval(() => {
    if (document.hidden) return;
    if (video.readyState >= 3 && video.paused) video.play().catch(() => {});
  }, 2000);
}
// 方案 B（兜底）：远程 MUX HLS 流，仅当本地视频文件缺失时启用
function tryStartHls(video) {
  if (!__bgNeedHls || !window.Hls || !Hls.isSupported()) return;
  __bgNeedHls = false;
  const src = "https://stream.mux.com/kimF2ha9zLrX64H00UgLGPflCzNtl1T0215MlAmeOztv8.m3u8";
  const hls = new Hls({ enableWorker: true });
  hls.loadSource(src);
  hls.attachMedia(video);
  hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
  // 错误明细记录（含非致命）：供 ?bgdebug=1 调试面板展示，定位失败原因
  hls.on(Hls.Events.ERROR, (_, data) => {
    (window.__hlsErrLog = window.__hlsErrLog || []).push({
      type: data.type, details: data.details, fatal: data.fatal,
      code: data.response && data.response.code,
    });
    // 致命错误时向 video 派发 error，让 Splash 的加载完成判定放行（避免按钮永不显现）
    if (data.fatal) video.dispatchEvent(new Event('error'));
  });
}

/* ============================================================
   BGM：单一低码率版本 + 音乐开关
   ============================================================ */
const BGM_SRC = './src/assets/audio/bgm-low.mp3';
let audioOn = !IS_MOBILE_VIEW;

function networkTier() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return 'good';
  if (['slow-2g', '2g', '3g'].includes(conn.effectiveType)) return 'poor';
  if (conn.effectiveType === '4g' && conn.downlink < 1.5) return 'poor';
  return 'good';
}
function bgmPlay() {
  const audio = $('#bgm');
  if (!audioOn) return;
  // Splash 期间已设置源并预加载；这里不重复设置 src，避免重新缓冲
  if (!audio.getAttribute('src')) audio.src = BGM_SRC;
  audio.volume = 1;
  audio.play().catch(() => {});
}
$('#audioToggle').addEventListener('click', () => {
  audioOn = !audioOn;
  const audio = $('#bgm');
  $('#noteIndicator').classList.toggle('off', !audioOn); // 暂停/关闭时显示斜杠、音符停止呼吸
  const btn = $('#audioToggle'); // 同步无障碍状态
  btn.setAttribute('aria-pressed', audioOn);
  btn.setAttribute('aria-label', audioOn ? '背景音乐：播放中' : '背景音乐：已暂停，点击播放');
  if (audioOn) bgmPlay(); // 沿用已加载的音源和播放位置，避免重新下载。
  else audio.pause();
});

/* ============================================================
   导航栏：滚动高亮 + 鼠标追踪光斑
   ============================================================ */
(function initNav() {
  const bar = $('#navBar'), glow = $('#navGlow');
  bar.addEventListener('mousemove', (e) => {
    const r = bar.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
    glow.style.background = `radial-gradient(100px circle at ${x}% 50%, rgba(255,255,255,0.12), transparent 70%)`;
    glow.style.opacity = 1;
  });
  bar.addEventListener('mouseleave', () => glow.style.opacity = 0);
  const buttons = [...$$('#navLinks button')];
  buttons.forEach((b) => b.addEventListener('click', () => scrollToSection(b.dataset.target)));
  const menuToggle = $('#menuToggle');
  const mobileMenu = $('#mobileMenu');
  const closeMobileMenu = () => {
    mobileMenu.classList.remove('open');
    mobileMenu.setAttribute('aria-hidden', 'true');
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('aria-label', '打开导航菜单');
  };
  menuToggle.addEventListener('click', () => {
    const open = !mobileMenu.classList.contains('open');
    mobileMenu.classList.toggle('open', open);
    mobileMenu.setAttribute('aria-hidden', String(!open));
    menuToggle.setAttribute('aria-expanded', String(open));
    menuToggle.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
  });
  $$('#mobileMenu button[data-target]').forEach((b) => b.addEventListener('click', () => {
    scrollToSection(b.dataset.target);
    closeMobileMenu();
  }));
  mobileMenu.addEventListener('click', (e) => { if (e.target === mobileMenu) closeMobileMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMobileMenu(); });
  // 滚动高亮 + 标签累积浮现：进入过的板块标签从左到右依次永久显示
  const ids = ['skills', 'projects', 'education', 'certificates', 'unique', 'contact'];
  const revealed = new Set();   // 已进入过的板块
  const reveal = (target) => {
    const b = buttons.find((x) => x.dataset.target === target);
    if (!b || revealed.has(target)) return;
    revealed.add(target);
    b.classList.add('seen');    // .seen 永久显示（浮现动画仅首次添加时播放一次）
  };
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      buttons.forEach((b) => b.classList.toggle('active', b.dataset.target === en.target.id));
      reveal(en.target.id);
    });
  }, { rootMargin: '-80px 0px -60% 0px' });
  ids.forEach((id) => { const el = document.getElementById(id); if (el) io.observe(el); });
  // 页脚 #contact 位于页面最底部且高度较矮，滚到底时顶部落不进主观测带（[80px,40%vh]），
  // 单独用整屏视口观测：页脚一旦进入视口即浮现并高亮"联系方式"
  const contactEl = document.getElementById('contact');
  if (contactEl) {
    const contactIo = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        buttons.forEach((b) => b.classList.toggle('active', b.dataset.target === 'contact'));
        reveal('contact');
      });
    });
    contactIo.observe(contactEl);
  }
  // 刷新于中段时：把已滚动过的板块标签一并补显，保持"已显示的永久保留"
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el && el.getBoundingClientRect().top <= 80) reveal(id);
  });
})();

/* ============================================================
   求学之路：滚动绘制轨迹 + 阶段聚焦 + 经历展开
   ============================================================ */
(function initEducationJourney() {
  const route = $('#eduRoute');
  if (!route) return;

  const path = $('#eduPathProgress');
  const traveler = $('#eduTraveler');
  const halo = $('#eduTravelerHalo');
  const label = $('#eduStageLabel');
  const count = $('#eduStageCount');
  const milestones = [...route.querySelectorAll('.edu-milestone')];
  const prefersReducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pathLength = path.getTotalLength();
  let ticking = false;

  path.style.strokeDasharray = `${pathLength}`;
  path.style.strokeDashoffset = `${pathLength}`;

  function updateJourney() {
    ticking = false;
    const rect = route.getBoundingClientRect();
    const viewportMarker = window.innerHeight * .68;
    const travelDistance = Math.max(rect.height - window.innerHeight * .28, 1);
    const progress = Math.max(0, Math.min(1, (viewportMarker - rect.top) / travelDistance));

    route.style.setProperty('--edu-progress', progress.toFixed(3));
    path.style.strokeDashoffset = `${pathLength * (1 - progress)}`;

    const point = path.getPointAtLength(pathLength * progress);
    [traveler, halo].forEach((node) => {
      node.setAttribute('cx', point.x.toFixed(2));
      node.setAttribute('cy', point.y.toFixed(2));
    });

    let current = null;
    milestones.forEach((milestone) => {
      if (milestone.getBoundingClientRect().top < window.innerHeight * .58) current = milestone;
    });
    if (current) {
      label.textContent = current.dataset.stage;
      count.textContent = `0${current.dataset.stageIndex} / 02`;
    } else {
      label.textContent = '旅程起点';
      count.textContent = '00 / 02';
    }
  }

  function requestJourneyUpdate() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(updateJourney);
  }

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) entry.target.classList.add('is-active');
      });
    }, { threshold: prefersReducedMotion ? 0 : .22, rootMargin: '0px 0px -12% 0px' });
    milestones.forEach((milestone) => observer.observe(milestone));
  } else {
    milestones.forEach((milestone) => milestone.classList.add('is-active'));
  }

  route.querySelectorAll('.edu-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      const card = button.closest('.edu-card');
      const detail = document.getElementById(button.getAttribute('aria-controls'));
      const open = !card.classList.contains('is-open');
      card.classList.toggle('is-open', open);
      button.setAttribute('aria-expanded', String(open));
      button.querySelector('span').textContent = open ? '收起这段经历' : '探索这段经历';
      if (detail) detail.setAttribute('aria-hidden', String(!open));
      requestJourneyUpdate();
    });
  });

  window.addEventListener('scroll', requestJourneyUpdate, { passive: true });
  window.addEventListener('resize', requestJourneyUpdate, { passive: true });
  updateJourney();
})();

/* ============================================================
   Hero：打字机座右铭 + 联系资料卡片
   ============================================================ */
(function initHero() {
  // 座右铭：纵向滚动式切换，每 2 秒滚动到下一句（滚动轨道方案）
  const track = $('#rotatingTrack');
  const rows = track.children;
  let idx = 0;
  setInterval(() => {
    idx = (idx + 1) % rows.length;
    track.style.transform = `translateY(${-idx * rows[0].offsetHeight}px)`;
  }, 2000);

  // 联系资料卡片
  const card = $('#contactCard'), btn = $('#contactBtn');
  const TEL = atob('MTkyMjk3NzAwOTU='); /* 电话号码防爬：Base64 存储，运行时解码 */
  const contacts = [
    { k: '<svg class="icon" viewBox="0 0 24 24"><path d="M5 4h3l2 5-2 1.5a12 12 0 0 0 5.5 5.5L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg>电话', v: TEL, copy: TEL },
    { k: '<svg class="icon" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 8 9 6 9-6"/></svg>Email', v: 'wzgsz2008@foxmail.com', copy: 'wzgsz2008@foxmail.com' },
    { k: '<svg class="icon" viewBox="0 0 24 24"><path d="M12 2.5C7 2.5 3 6.5 3 11.7c0 4 2.6 7.5 6.2 8.7.5.1.6-.2.6-.4v-1.5c-2.5.5-3-1.2-3-1.2-.4-1-1-1.3-1-1.3-.8-.6.1-.6.1-.6.9.1 1.4.9 1.4.9.8 1.4 2.1 1 2.6.8.1-.6.3-1 .6-1.3-2-.2-4-.9-4-4.2 0-.9.3-1.7.9-2.3-.1-.2-.4-1.1.1-2.2 0 0 .7-.2 2.3.9a7.8 7.8 0 0 1 4.2 0c1.6-1.1 2.3-.9 2.3-.9.5 1.1.2 2 .1 2.2.6.6.9 1.4.9 2.3 0 3.3-2 4-4 4.2.3.3.6.9.6 1.7v2.5c0 .2.1.5.6.4a9 9 0 0 0 6.2-8.7C21 6.5 17 2.5 12 2.5z"/></svg>GitHub', v: 'jiostrider', href: 'https://github.com/jiostrider' },
    { k: '<svg class="icon" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 10v7M8 7v.01M12 17v-4a2 2 0 0 1 4 0v4"/></svg>LinkedIn', v: '高晟哲', href: 'https://www.linkedin.com/in/shengzhe-gao/' },
    { k: '<svg class="icon" viewBox="0 0 24 24"><path d="M9.6 4.3C6.5 4.3 4 6.4 4 9.1c0 1.5.7 2.8 1.9 3.7l-.6 2.2 2.4-1.3c.6.2 1.2.3 1.9.3"/><path d="M14.4 8.6c-3.2 0-5.8 2.1-5.8 4.7 0 2.6 2.6 4.7 5.8 4.7.7 0 1.3-.1 1.9-.3l2.4 1.2-.6-2.1c1.2-.9 1.9-2.2 1.9-3.6 0-2.6-2.6-4.7-5.6-4.6z"/><path d="M6.8 9.2h.01M9.2 9.2h.01M12.7 13.1h.01M16.6 13.1h.01"/></svg>微信', v: '扫码添加', qrImg: './src/assets/media/wechat-qr.jpg', qrLabel: '微信扫一扫，添加好友' },
    { k: '<svg class="icon" viewBox="0 0 24 24"><path d="M10.17 3.33 L8.91 4.04 L8.13 4.74 L7.39 5.7 L6.76 6.96 L6.35 8.44 L6.28 10.59 L5.17 13.22 L4.54 15.48 L4.39 16.63 L4.5 17.59 L4.61 17.74 L5.17 17.26 L6.13 15.81 L6.35 17.07 L6.65 17.78 L7.31 18.74 L8.06 19.41 L6.83 19.89 L6.39 20.26 L6.35 20.59 L6.91 20.85 L9.13 20.96 L12.43 20.7 L14.2 20.93 L16.13 20.96 L17.31 20.78 L17.54 20.67 L17.65 20.44 L17.28 20.0 L15.91 19.41 L16.5 18.89 L17.13 18.07 L17.61 17.0 L17.8 15.85 L18.69 17.15 L19.31 17.74 L19.5 17.48 L19.57 16.7 L19.43 15.52 L18.98 13.81 L17.65 10.48 L17.61 8.59 L17.09 6.74 L16.65 5.85 L15.98 4.93 L15.13 4.11 L14.13 3.48 L13.2 3.15 L12.31 3.0 L11.28 3.04 Z"/></svg>QQ', v: '扫码添加', qrImg: './src/assets/media/qq.webp', qrLabel: 'QQ 扫一扫，添加好友' },
	  ];
  card.innerHTML = `
    <h3>联系方式 <span style="font-weight:400;"><button class="copy-btn" style="background:none;border:none;color:rgba(255,255,255,0.4);font-size:12px;" onclick="document.getElementById('contactCard').style.display='none'">关闭</button></span></h3>
    <div class="contact-body">
      <img class="contact-avatar" data-src="./src/assets/images/avatar.webp" alt="头像" loading="lazy" decoding="async" />
      <div class="contact-rows">
        ${contacts.map((c) => {
          const act = c.href ? `window.open('${c.href}','_blank','noopener, noreferrer')`
                    : c.copy ? `copyRow(this)`
                    : c.qrImg ? `openQR('${c.qrImg}','${c.qrLabel}')` : '';
          return `
          <div class="row clickable" role="button" tabindex="0" onclick="${act}">
            <span class="k">${c.k}</span>
            <span class="v">
              ${c.v}
              ${c.href ? `<a href="${c.href}" target="_blank" rel="noopener noreferrer" style="color:rgba(255,255,255,0.5);text-decoration:none;" onclick="event.stopPropagation()">↗</a>` : ''}
              ${c.copy ? `<button class="copy-btn" data-copy="${c.copy}" onclick="event.stopPropagation();copyText(this)">⧉</button>` : ''}
              ${c.qrImg ? `<button class="qr-btn" onclick="event.stopPropagation();openQR('${c.qrImg}','${c.qrLabel}')">📱</button>` : ''}
            </span>
          </div>`;
        }).join('')}
      </div>
    </div>
  `;
  btn.addEventListener('click', () => {
    if (card.style.display === 'none') {
      // 重新触发平滑出现动画（每次打开都重播，避免仅首次生效）
      card.style.animation = 'none';
      void card.offsetWidth; // 强制回流，重置动画
      card.style.display = '';
      card.style.animation = '';
    } else {
      card.style.display = 'none';
    }
  });
})();
function copyText(btn) {
  navigator.clipboard.writeText(btn.dataset.copy).then(() => {
    btn.textContent = '✓'; btn.classList.add('ok');
    setTimeout(() => { btn.textContent = '⧉'; btn.classList.remove('ok'); }, 1500);
  });
}
function copyRow(row) {
  const btn = row.querySelector('.copy-btn');
  if (btn) copyText(btn);
}
function openQR(src, label) {
  const lb = document.getElementById('qrLightbox');
  if (!lb) return;
  document.getElementById('qrImg').src = src;
  document.getElementById('qrImg').alt = label;
  document.getElementById('qrLabel').textContent = label;
  lb.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}
function closeQR(e) {
  // 如果点击的是遮罩本身（非内部卡片），或显式调用（无参数），都关闭
  if (e && e.target !== e.currentTarget) return;
  const lb = document.getElementById('qrLightbox');
  if (lb) { lb.style.display = 'none'; }
  document.body.style.overflow = '';
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const lb = document.getElementById('qrLightbox');
    if (lb && lb.style.display !== 'none') { lb.style.display = 'none'; document.body.style.overflow = ''; }
  }
});

/* ============================================================
   我能为你做什么：服务菜单（行高亮 + 浮动详情卡跟随鼠标）
   ============================================================ */
(function initServices() {
  const services = [
    {
      num: '01',
      title: 'AI 工作流与智能体搭建', en: 'AI Workflow & Agents',
      forWhom: '实验室 / 教授',
      items: [
        '多模型 LLM 协同工作流方案设计',
        '智能体应用原型搭建与演示 Demo',
        '课题 / 科研场景 AI 辅助工具开发',
        'Prompt 工程设计与效果调优',
      ],
      proof: '背书：OpenAI Academy「Agents and Workflows」结业认证 · 达摩院人工智能训练师（高级）',
    },
    {
      num: '02',
      title: '网站与交互应用开发', en: 'Web & Interactive Apps',
      forWhom: '学长项目组 / 团队',
      items: [
        '项目官网 / 实验室主页一站式搭建',
        '在线工具与 H5 互动页面开发',
        '作品集与个人品牌网站定制',
        '域名部署与性能优化（Netlify 实战）',
      ],
      proof: '背书：4 个已上线项目 · 本站独立开发（原生 JS/CSS 零构建复刻 React 级动效）',
    },
    {
      num: '03',
      title: '演示设计与视觉表达', en: 'Presentation & Visual',
      forWhom: '老师 / 课程汇报',
      items: [
        '课程汇报 / 竞赛答辩 PPT 设计',
        '学术海报与数据可视化美化',
        '演示叙事逻辑梳理与打磨',
        '原创配图与视觉素材制作',
      ],
      proof: '背书：中国美术学院素描捌级 · 全英演示文稿 Freshman\'s Dilemma',
    },
    {
      num: '04',
      title: '电子创客与 IoT 原型', en: 'Maker & IoT Prototyping',
      forWhom: '专业课程 / 兴趣小组',
      items: [
        '传感器装置原型制作与调试',
        '循迹小车等智能小车实践',
        'IoT 课程实验协作与问题排查',
        '创意硬件小项目孵化与组队',
      ],
      proof: '背书：物联网工程专业（211）· 2 件可演示实物作品（循迹小车 / 数码管时钟）',
    },
  ];
  const detailHTML = (s) => `
    <ul class="fl-list">${s.items.map((it) => `<li>${it}</li>`).join('')}</ul>
    <div class="svc-proof">${s.proof}</div>`;
  const list = $('#svcList');
  list.innerHTML = services.map((s, i) => `
    <div class="svc-row reveal" data-i="${i}" style="transition-delay:${i * 80}ms;">
      <span class="no">${s.num}</span>
      <div class="tt">
        <h3>${s.title}</h3>
        <p class="en">+ ${s.en} +</p>
      </div>
      <span class="meta">面向 ${s.forWhom}</span>
      <div class="svc-detail">${detailHTML(s)}</div>
    </div>`).join('');
  const rows = $$('#svcList .svc-row');
  const hoverable = window.matchMedia('(hover: hover)').matches;

  if (hoverable) {
    // 桌面：仅在实际移动鼠标时激活（mousemove），避免滚轮滚动把元素移入光标下导致的误触发
    const float = $('#svcFloat');
    let tx = 0, ty = 0, cx = 0, cy = 0, rot = 0, on = false, raf = null;
    let activeRow = null;
    const setTarget = (e) => {
      const w = float.offsetWidth || 320, h = float.offsetHeight || 280;
      tx = Math.min(innerWidth - w - 12, Math.max(12, e.clientX + 32));
      ty = Math.min(innerHeight - h - 12, Math.max(12, e.clientY - h / 2));
    };
    const tick = () => {
      const dx = tx - cx;
      cx += dx * 0.14; cy += (ty - cy) * 0.14;
      rot += (Math.max(-10, Math.min(10, dx * 0.09)) - rot) * 0.12;
      // rotate 用独立属性写入，避免与弹出动画的 rotate 关键帧冲突
      float.style.transform = `translate(${cx}px, ${cy}px)`;
      float.style.rotate = `${rot}deg`;
      raf = (on || Math.abs(tx - cx) > 0.5 || Math.abs(ty - cy) > 0.5) ? requestAnimationFrame(tick) : null;
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };
    // 统一入口：根据坐标激活 / 切换 / 清除高亮行
    let mx = -1, my = -1;
    const rowAt = (x, y) => {
      const el = document.elementFromPoint(x, y);
      return el ? el.closest('#svcList .svc-row') : null;
    };
    const update = (x, y) => {
      const row = rowAt(x, y);
      if (row) {
        if (row !== activeRow) activate(row, { clientX: x, clientY: y });
        else if (on) setTarget({ clientX: x, clientY: y });
      } else if (activeRow) clear();
    };
    // 真实鼠标移动
    window.addEventListener('mousemove', (e) => {
      mx = e.clientX; my = e.clientY;
      update(mx, my);
    }, { passive: true });
    // 滚轮滚动时光标不动：主动检测光标下是哪一行（不依赖浏览器派发悬停事件）
    window.addEventListener('scroll', () => { if (mx >= 0) update(mx, my); }, { passive: true });
    const activate = (row, e) => {
      activeRow = row;
      rows.forEach((r) => r.classList.remove('is-hot'));
      row.classList.add('is-hot');
      const s = services[+row.dataset.i];
      float.innerHTML = `<div class="fh"><span class="n">${s.num}</span><h4>${s.title}</h4></div>` + detailHTML(s);
      setTarget(e);
      if (!on) {
        // 首次出现：从触碰点位弹出，随后惯性滑向目标位
        cx = Math.min(innerWidth - (float.offsetWidth || 320) - 12, Math.max(12, e.clientX));
        cy = Math.min(innerHeight - (float.offsetHeight || 280) - 12, Math.max(12, e.clientY - (float.offsetHeight || 280) / 2));
        rot = 0;
      }
      on = true;
      float.classList.add('on');
      // 每次进入新行都重新触发旋转弹出
      float.classList.remove('pop');
      void float.offsetWidth;
      float.classList.add('pop');
      kick();
    };
    const clear = () => {
      activeRow = null;
      rows.forEach((r) => r.classList.remove('is-hot'));
      on = false;
      float.classList.remove('on');
      float.classList.remove('pop');
    };
    list.addEventListener('mouseleave', clear);
  } else {
    // 触屏：点击行展开 / 收起详情
    rows.forEach((row) => {
      row.addEventListener('click', () => row.classList.toggle('open'));
    });
  }
})();

/* ============================================================
   能力雷达图：SVG 网格 + 弹簧展开动画
   ============================================================ */
(function initRadar() {
  const dims = [
    { label: 'PPT', v: 80 },
    { label: 'Prompt Engineering', v: 80 },
    { label: '网页制作', v: 90 },
    { label: 'AI工作流编排', v: 85 },
    { label: '多模型协同', v: 80 },
  ];
  const cx = 280, cy = 240, r = 140, labelR = 155;
  const pt = (i, rad) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / dims.length;
    return { x: cx + rad * Math.cos(a), y: cy + rad * Math.sin(a) };
  };
  const poly = (vals) => vals.map((v, i) => { const p = pt(i, (r * v) / 100); return `${p.x},${p.y}`; }).join(' ');
  const svg = $('#radar');
  let markup = '';
  // 背景网格（4 层）与轴线
  [0.25, 0.5, 0.75, 1].forEach((lv) => {
    markup += `<polygon points="${poly(dims.map(() => lv * 100))}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1" />`;
  });
  dims.forEach((_, i) => {
    const o = pt(i, r);
    markup += `<line x1="${cx}" y1="${cy}" x2="${o.x}" y2="${o.y}" stroke="rgba(255,255,255,0.08)" stroke-width="1" />`;
  });
  // 数据多边形（初始收缩在中心，入场后展开）
  const target = dims.map((d) => d.v);
  const center = dims.map(() => 0);
  // 打印/导出 PDF 时强制使用最终展开态（动画未触发时避免打印出退化图形）
  window.__radarTarget = poly(target);
  markup += `<polygon id="dataPoly" points="${poly(center)}" fill="rgba(99,102,241,0.2)" stroke="rgba(99,102,241,0.8)" stroke-width="2" stroke-linejoin="round" />`;
  // 标签
  dims.forEach((d, i) => {
    const p = pt(i, labelR);
    let anchor = 'middle', dx = 0, dy = 0;
    if (p.x < cx - 60) { anchor = 'end'; dx = -6; }
    else if (p.x > cx + 60) { anchor = 'start'; dx = -6; }
    if (i === 0) dy = -4; else if (i === 2 || i === 3) dy = 16;
    markup += `<text x="${p.x + dx}" y="${p.y + dy}" text-anchor="${anchor}" fill="rgba(255,255,255,0.75)" font-size="14" font-weight="500" opacity="0">${d.label}</text>`;
  });
  svg.innerHTML = markup;

  // 入场：滚动进入视口时播放展开动画（easeOut 逼近）
  const polyEl = $('#dataPoly');
  const texts = svg.querySelectorAll('text');
  const io = new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting) return;
    const start = performance.now(), dur = 1200;
    const from = dims.map(() => 0), to = target;
    (function anim(now) {
      const t = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - t, 3); // easeOutCubic，逼近原弹簧落点
      const cur = from.map((f, i) => f + (to[i] - f) * e);
      polyEl.setAttribute('points', poly(cur));
      if (t < 1) requestAnimationFrame(anim);
    })(start);
    texts.forEach((tx, i) => setTimeout(() => tx.style.opacity = 1, 800 + i * 100));
    io.disconnect();
  }, { threshold: 0.2 });
  io.observe($('#skills'));
})();

/* ============================================================
   AI 实战作品：扑克牌堆叠轮播
   （交互逻辑学习改造自 github.com/JIEJOE-WEB-Tutorial/001-poker-slides：
   每张牌记住自己的层位 nums，点击后全员 +1；最顶的牌循环回最底层时
   瞬间关闭过渡，避免"倒着飞回去"的穿帮——即原教程提到的闪动 BUG 解法）
   ============================================================ */
(function initPoker() {
  const projects = [
    { id: '01', title: 'CET-4 英语四级在线模拟', link: 'https://cet-4-online.netlify.app/', img: './src/assets/images/cet4.webp' },
    { id: '02', title: '《飞机大战》', link: 'https://feijidazhan0.netlify.app/', img: './src/assets/images/feijidazhan.webp' },
    { id: '03', title: '《小恐龙跑酷》', link: 'https://xiaokonglong01.netlify.app/', img: './src/assets/images/xiaokonglong.webp' },
    { id: '04', title: '《坦克大战·GSZ战场》', link: 'https://jiostrider.github.io/tank/', img: './src/assets/images/tank.png' },
  ];
  const transforms = [
    'rotate(-9deg)',
    'rotate(-3deg) translate(38%, -12%)',
    'rotate(2deg) translate(74%, -20%)',
    'rotate(7deg) translate(110%, -28%)',
  ];
  const stage = $('#pokerStage');
  stage.innerHTML = projects.map((p, i) => `
    <div class="poker-card" data-i="${i}">
      <img data-src="${p.img}" alt="${p.title}" loading="lazy" decoding="async" />
      <div class="cap"><span>${p.title}</span></div>
    </div>`).join('');
  const cards = [...stage.children];
  cards.forEach((c, i) => {
    c.nums = i;
    c.style.zIndex = i;
    c.style.transform = transforms[i];
  });
  const numEl = $('#pokerNum'), titleEl = $('#pokerTitle'), linkEl = $('#pokerLink');
  const syncMeta = () => {
    const top = cards.reduce((a, b) => (b.nums > a.nums ? b : a));
    const p = projects[+top.dataset.i];
    numEl.textContent = `${p.id} / 0${projects.length}`;
    titleEl.textContent = p.title;
    linkEl.href = p.link;
  };
  const move = () => {
    cards.forEach((ele) => {
      let nums = ele.nums;
      if (nums + 1 >= cards.length) {
        nums = 0;
        ele.style.transition = ''; // 回到底层：关闭过渡，瞬间落牌
      } else {
        nums += 1;
        ele.style.transition = 'transform 0.35s cubic-bezier(0.22, 0.61, 0.36, 1)';
      }
      ele.style.zIndex = nums;
      ele.style.transform = transforms[nums];
      ele.nums = nums;
    });
    syncMeta();
  };
  stage.addEventListener('click', move);
  $('.poker-hint').addEventListener('click', move); // 点击提示胶囊同样换牌
  syncMeta();
})();

/* ============================================================
   PPT 轮播：自动播放 + 导航 + 全屏（原生实现，复刻 Swiper）
   ============================================================ */
(function initPPT() {
  const slides = [
    { n: '01', title: '封面 - Freshman\'s Dilemma', sub: 'The Paralysis of Choice' },
    { n: '02', title: '原文段落展示', sub: 'Key Passage Analysis' },
    { n: '03', title: '重点词汇讲解', sub: 'Key Vocabulary' },
    { n: '04', title: '长难句结构分析', sub: 'Complex Sentence Structure' },
    { n: '05', title: '段落主旨 & 作用', sub: 'Main Idea & Function' },
    { n: '06', title: '课堂讨论', sub: 'Class Discussion' },
  ];
  const track = $('#pptTrack'), dots = $('#pptDots'), num = $('#pptNum');
  track.innerHTML = slides.map((s, i) => `
    <div class="swiper-slide">
      <img data-src="./src/assets/images/Freshmans-Dilemma-The-Paralysis-of-Choice (1)_0${i + 1}.webp" alt="${s.title}" loading="lazy" decoding="async" />
      <div class="cap">${s.title}</div>
    </div>`).join('');
  dots.innerHTML = slides.map((_, i) => `<i data-i="${i}"></i>`).join('');
  let idx = 0, timer = null;
  const go = (i) => {
    idx = (i + slides.length) % slides.length;
    track.style.transform = `translateX(-${idx * 100}%)`;
    num.textContent = `${slides[idx].n} / 0${slides.length}`;
    dots.querySelectorAll('i').forEach((d, j) => d.classList.toggle('on', j === idx));
  };
  const autoplay = () => { clearInterval(timer); timer = setInterval(() => go(idx + 1), 3000); };
  $('#pptNext').addEventListener('click', () => { go(idx + 1); autoplay(); });
  $('#pptPrev').addEventListener('click', () => { go(idx - 1); autoplay(); });
  dots.addEventListener('click', (e) => {
    if (e.target.tagName === 'I') { go(+e.target.dataset.i); autoplay(); }
  });
  $('#pptFull').addEventListener('click', () => {
    const wrap = $('#pptWrap');
    if (!document.fullscreenElement) wrap.requestFullscreen?.();
    else document.exitFullscreen?.();
  });
  go(0);
  autoplay();
})();

/* ============================================================
   荣誉认证
   ============================================================ */
(function initCerts() {
  const certs = [
    { name: 'Applied AI Foundations 课程结业证书', issuer: 'OpenAI Academy', id: 'ghrhss5fkt', date: '2026.08.26', holder: 'Shengzhe Gao', img: 'cert-applied-ai-foundations.webp' },
    { name: 'Agents and Workflows 课程结业证书', issuer: 'OpenAI Academy', id: 'ze3xowby0q', date: '2026.08.26', holder: 'Shengzhe Gao', img: 'cert-agents-workflows.webp' },
    { name: 'AI Foundations 课程结业证书', issuer: 'OpenAI Academy', id: 'mif4jmueqk', date: '2026.08.25', holder: 'Shengzhe Gao', img: 'cert-unnamed.webp' },
    { name: '达摩院人工智能训练师（高级）', issuer: 'DAMO Academy', id: 'AIT260819181414000127', date: '2026.08.19', img: 'ai-trainer-cert.webp' },
    { name: '达摩院人工智能训练师（初级）', issuer: 'DAMO Academy', id: 'AIT260809225938000178', date: '2026.08.09', img: 'certificate.webp' },
    { name: '阿里云 Apsara Clouder · VISION 人工智能设计（入门）', issuer: 'Alibaba Cloud', id: 'CLDM06260802763267', date: '2026.08.19', img: 'alibaba-cloud-vision-cert.webp' },
    { name: '阿里云 Apsara Clouder · 基于百炼平台构建智能体应用', issuer: 'Alibaba Cloud', id: 'CLDM02260802762629', date: '2026.08.18', img: 'alibaba-cloud-agent-builder-cert.webp' },
    { name: '阿里云 Apsara Clouder · Spring AI 应用开发（入门）', issuer: 'Alibaba Cloud', id: 'CLDM09260802763268', date: '2026.08.19', img: 'alibaba-cloud-spring-ai-cert.webp' },
    { name: '阿里云 Apsara Clouder · 基于 PAI ArtLab 的 AIGC 设计基础', issuer: 'Alibaba Cloud', id: 'CLDM05260802763264', date: '2026.08.19', img: 'alibaba-cloud-aigc-cert.webp' },
  ];
  $('#certList').innerHTML = certs.map((c) => `
    <div class="cert-card liquid-glass">
      <div class="text-left">
        <h3>${c.name}</h3>
        ${c.issuer ? `<p class="org">${c.issuer}</p>` : ''}
        ${c.holder ? `<p class="org">持证：${c.holder}</p>` : ''}
        ${c.id ? `<p class="muted">ID: ${c.id}</p>` : ''}
        ${c.date ? `<p class="muted">日期：${c.date}</p>` : ''}
      </div>
      <img data-src="./src/assets/images/${c.img}" alt="${c.name}" loading="lazy" decoding="async" />
    </div>`).join('');

  /* ---- 2D 无限循环证书墙（原理同 JIEJOE/008-infinite-scrolling）----
     卡片按 cols×rows 铺成一个比可视区大一圈的晶格；拖拽改变共享偏移，
     每帧把每张卡片对晶格周期取模"传送"回窗口内 —— 平移量恒为间距的整数倍，
     晶格永远完美对齐，四方向都拖不到尽头。
     升级点：用帧率无关的阻尼插值替代 GSAP 逐事件动画，松手带惯性滑行。 */
  const stage = $('#certStage');
  if (stage) {
    let cells = [], cols = 0, rows = 0, px = 0, py = 0, cw = 0, ch = 0, W = 0, H = 0, gx = 0, gy = 0;
    const tgt = { x: 0, y: 0 }, sm = { x: 0, y: 0 }, vel = { x: 0, y: 0 };
    const DRAG_SPEED = 2;   // 拖拽灵敏度：画布位移 = 光标位移 × 2，视觉上底层卡片跑得比光标快
    let dragging = false, raf = 0, lastT = 0, lastMoveT = 0, lastP = null, pid = null;
    let hoverCell = null, downCell = null, moved = 0;

    const mod = (v, m) => ((v % m) + m) % m;

    /* ---- 拖拽提示浮层（首次拖拽后淡出） ---- */
    const hint = document.createElement('div');
    hint.className = 'cert-hint';
    hint.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="#a78bfa"/><path d="M12.6 11.4 16 8M11.8 8H16v4.2M11.4 12.6 8 16M12.2 16H8v-4.2" stroke="rgba(0,0,0,0.8)" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>` +
      `<span><b>按住拖拽 · 四向无限滑动</b><i>拖动查看更多证书</i></span>`;

    /* ---- DRAG 环绕字样容器（build 时按舞台尺寸生成 SVG textPath，排布在紫色边框正中） ---- */
    const dragRing = document.createElement('div');
    dragRing.className = 'cert-drag-ring';
    let ringTextPath = null, copyTextPath = null, ringPathLen = 0, ringOff = 0;   // 传送带状态：主/副本 textPath 引用、整圈周长、当前沿路径偏移量
    const RING_SPEED = 40;   // 传送带线性速度（px/s），拖拽触发时沿紫色条带顺时针环移

    /* ---- 光标徽章：替代系统光标，箭头实时对齐卡片整体运动方向 ---- */
    const badge = document.createElement('div');
    badge.className = 'cert-cursor-badge';
    badge.innerHTML = `<span class="scale"><svg viewBox="0 0 24 24" width="36" height="36"><circle cx="12" cy="12" r="10.5" fill="#a78bfa" stroke="rgba(0,0,0,0.55)" stroke-width="1"/><path d="M12.6 11.4 16 8M11.8 8H16v4.2M11.4 12.6 8 16M12.2 16H8v-4.2" stroke="rgba(0,0,0,0.8)" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
    document.body.appendChild(badge);
    stage.classList.add('badge-on');   // 徽章就绪后隐藏系统光标
    const badgePos = { x: -100, y: -100 };
    let badgeRot = -45;                // 基准箭头指向 ↗（-45°）
    const lerpAngle = (a, b, t) => a + (((b - a + 540) % 360) - 180) * t;
    function syncBadge() {
      badge.style.transform = `translate(${badgePos.x - 18}px, ${badgePos.y - 18}px) rotate(${badgeRot.toFixed(2)}deg)`;
    }
    function syncBadgeRot(dt) {
      const sp = Math.hypot(vel.x, vel.y);
      if (sp > 0.05) {  // 卡片在动：箭头轴对齐实时速度方向（拖拽与惯性滑行均跟随）
        const target = Math.atan2(vel.y, vel.x) * 180 / Math.PI + 45;
        badgeRot = lerpAngle(badgeRot, target, 1 - Math.pow(0.65, (dt || 16.7) / 16.667));
      }
    }
    document.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;   // 触屏无光标概念
      const over = dragging || stage.contains(e.target);
      badge.classList.toggle('show', over);   // 入场/出场缩放+淡入由 .show 类 + CSS 过渡驱动
      if (!over) return;
      badgePos.x = e.clientX; badgePos.y = e.clientY;
      syncBadgeRot(); syncBadge();
    });

    function build() {
      const probe = document.createElement('div');
      probe.className = 'cert-cell';
      probe.style.visibility = 'hidden';
      stage.appendChild(probe);
      cw = probe.offsetWidth; ch = probe.offsetHeight;
      px = cw + 24;  // 24 = 晶格间距（与视觉留白一致）
      py = ch + 24;
      probe.remove();
      const sw = stage.clientWidth, sh = stage.clientHeight;
      // 9×9 固定排布周期：晶格边长取 9 的倍数，保证任意相位下 9×9 拉丁方阵无缝循环
      cols = 9 * Math.max(1, Math.ceil((sw + 2 * px) / (9 * px)));
      rows = 9 * Math.max(1, Math.ceil((sh + 2 * py) / (9 * py)));
      W = cols * px; H = rows * py;
      gx = (sw - W) / 2; gy = (sh - H) / 2;
      stage.innerHTML = '';
      cells = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          // 拉丁方阵：行内步进 1、列内步进 4（4 与 9 互质），任意 9×9 范围内
          // 每行/每列 9 格恰好各出现一次，相邻（含对角）证书互不重复
          const idx = (4 * (r % 9) + (c % 9)) % certs.length;
          const d = certs[idx];
          const el = document.createElement('div');
          el.className = 'cert-cell';
          // 负延迟让各卡片浮动相位错开
          el.innerHTML = `<div class="cert-float" style="animation-delay:${-((r * cols + c) % 9) * 0.5}s">` +
            `<div class="cert-inner liquid-glass" data-idx="${idx}">` +
            `<img data-src="./src/assets/images/${d.img}" alt="${d.name}" loading="lazy" decoding="async" draggable="false" />` +
            `<h3>${d.name}</h3>${d.issuer ? `<p class="org">${d.issuer}</p>` : ''}` +
            `</div></div>`;
          stage.appendChild(el);
          cells.push({ el, idx, inner: el.querySelector('.cert-inner'), bx: c * px, by: r * py, rx: 0, ry: 0 });
        }
      }
      render();
      // 生成 DRAG 环绕字样：SVG textPath 沿边框内侧一圈排布 "DRAG · "，贴近边框里侧（不含外）
      const inset = 22, rad = 16;   // inset 22 > 边框半宽16：把文字整体向内部推移，聚焦于紫色条带内侧；rad 保持圆角半径
      const rp = (sw, sh) => `M ${inset + rad},${inset}` +
        ` H ${sw - inset - rad}` +
        ` Q ${sw - inset},${inset} ${sw - inset},${inset + rad}` +
        ` V ${sh - inset - rad}` +
        ` Q ${sw - inset},${sh - inset} ${sw - inset - rad},${sh - inset}` +
        ` H ${inset + rad}` +
        ` Q ${inset},${sh - inset} ${inset},${sh - inset - rad}` +
        ` V ${inset + rad}` +
        ` Q ${inset},${inset} ${inset + rad},${inset} Z`;
      dragRing.innerHTML = `<svg viewBox="0 0 ${sw} ${sh}" preserveAspectRatio="none" aria-hidden="true">` +
        `<defs><path id="certDragPath" d="${rp(sw, sh)}" /></defs>` +
        `<text class="cert-drag-text"><textPath id="certRingA" href="#certDragPath" startOffset="0"></textPath></text>` +
        `<text class="cert-drag-text"><textPath id="certRingB" href="#certDragPath" startOffset="0"></textPath></text></svg>`;
      stage.appendChild(dragRing);
      // 按路径实际周长动态填充文字量，并用 textLength 精确铺满整圈
      // （固定 24 组会因周长 > 文字长度导致左侧边框出现无字空段）
      const ringPath = dragRing.querySelector('#certDragPath');
      const plen = ringPath.getTotalLength();
      ringPathLen = plen; ringOff = 0;
      // 双副本无缝传送带：A、B 各自铺满一整圈。环移时 A 起点 offset=s 覆盖 [s,plen]，
      // B 起点 offset=s-plen 覆盖 [0,s]，两者无重叠拼接整圈 —— 左侧消失的字由 B 的尾部
      // 在右侧无缝补全，整圈任意位置始终有字，永不出现缺口或被裁掉
      const ringA = dragRing.querySelector('#certRingA');
      const ringB = dragRing.querySelector('#certRingB');
      // 先在 A 上累加出一份恰好铺满整圈的字符串，再由 A/B 共用同一份 txt，
      // 保证两份 textPath 几何完全对齐，杜绝双副本错位导致的拖拽抖动/闪现
      const telA = ringA.closest('text');
      let txt = 'DRAG · ';
      ringA.textContent = txt;
      while (telA.getComputedTextLength() < plen) { txt += 'DRAG · '; ringA.textContent = txt; }
      ringA.textContent = ringB.textContent = txt;
      ringA.setAttribute('textLength', Math.round(plen));
      ringA.setAttribute('lengthAdjust', 'spacing');
      ringB.setAttribute('textLength', Math.round(plen));
      ringB.setAttribute('lengthAdjust', 'spacing');
      ringTextPath = ringA; copyTextPath = ringB;
      stage.appendChild(hint);  // innerHTML 清空会移除提示浮层，每次 build 后重新挂载
    }

    function render() {
      for (const cell of cells) {
        cell.rx = gx + mod(cell.bx + sm.x - gx, W);
        cell.ry = gy + mod(cell.by + sm.y - gy, H);
        cell.el.style.transform = `translate3d(${cell.rx}px,${cell.ry}px,0)`;
      }
    }

    function kick() {
      if (!raf) {
        stage.classList.add('moving');   // 卡片开始运动：临时去模糊 + 暂停浮动动画
        // 拖拽前先把双副本 startOffset 一次性铺到当前目标并强制 reflow，
        // 避免 rAF 首帧才首次渲染负值 offset 导致的"左上角文字冒出"闪现
        if (ringTextPath && copyTextPath && ringPathLen) {
          ringTextPath.setAttribute('startOffset', ringOff);
          copyTextPath.setAttribute('startOffset', ringOff - ringPathLen);
          void stage.offsetWidth;   // 读取触发强制同步布局，让负 offset 的排版先行就绪
        }
        lastT = performance.now(); raf = requestAnimationFrame(loop);
      }
    }

    function loop(now) {
      const dt = Math.min(now - lastT, 64); lastT = now;
      if (!dragging) {
        // 惯性：速度按帧率无关的阻尼衰减，低于阈值归零（0.75/帧=轻微滑行，避免松手后画布多滑一段被误判为 2x）
        const decay = Math.pow(0.75, dt / 16.667);
        vel.x *= decay; vel.y *= decay;
        if (Math.hypot(vel.x, vel.y) < 0.02) vel.x = vel.y = 0;
        tgt.x += vel.x * dt; tgt.y += vel.y * dt;
      }
      // 平滑跟随（阻尼插值，帧率无关）
      const k = 1 - Math.pow(1 - 0.3, dt / 16.667);
      sm.x += (tgt.x - sm.x) * k;
      sm.y += (tgt.y - sm.y) * k;
      render();
      // 拖拽触发（DRAG 条带淡入）时，文字沿整圈做“传送带”式顺时针环移；
      // 文字已 textLength 铺满整圈且首尾衔接，偏移量对周长期取模 → 视觉上无缝、始终停在紫色条带上
      if (dragging && ringTextPath && ringPathLen) {
        ringOff = (ringOff + RING_SPEED * dt / 1000) % ringPathLen;
        // 主副本起点 = s 覆盖 [s,plen]；副本起点 = s-plen 覆盖 [0,s]，无缝拼接整圈
        ringTextPath.setAttribute('startOffset', ringOff);
        if (copyTextPath) copyTextPath.setAttribute('startOffset', ringOff - ringPathLen);
      }
      // 惯性滑行期指针静止，箭头仍需跟随卡片运动方向旋转
      if (badge.style.display === 'block') { syncBadgeRot(dt); syncBadge(); }
      const settled = !dragging && vel.x === 0 && vel.y === 0 &&
        Math.abs(tgt.x - sm.x) < 0.5 && Math.abs(tgt.y - sm.y) < 0.5;
      if (settled) {
        sm.x = tgt.x; sm.y = tgt.y; render();
        stage.classList.remove('moving');  // 运动停止：恢复毛玻璃与浮动动画
        raf = 0; return;
      }
      raf = requestAnimationFrame(loop);
    }

    /* ---- 3D 悬浮倾斜：光标相对卡片中心的偏移 → rotateX/rotateY + 抬升 ---- */
    function findCell(e) {
      const rect = stage.getBoundingClientRect();   // 指针视口坐标 → 舞台本地坐标
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      for (const cell of cells) {
        if (x >= cell.rx && x <= cell.rx + cw && y >= cell.ry && y <= cell.ry + ch) return cell;
      }
      return null;
    }
    function clearTilt() {
      if (hoverCell) { hoverCell.inner.style.transform = ''; hoverCell.inner.classList.remove('lit'); hoverCell.el.style.zIndex = ''; hoverCell = null; }
    }
    function tiltAt(e) {
      const cell = findCell(e);
      if (hoverCell && hoverCell !== cell) clearTilt();
      hoverCell = cell;
      if (!cell) return;
      const ix = (e.clientX - cell.rx) / cw - 0.5;   // -0.5 ~ 0.5
      const iy = (e.clientY - cell.ry) / ch - 0.5;
      cell.inner.style.transform = `perspective(700px) rotateX(${(-iy * 12).toFixed(2)}deg) rotateY(${(ix * 12).toFixed(2)}deg) translateZ(16px)`;
      cell.inner.classList.add('lit');
      cell.el.style.zIndex = 5;
    }

    /* ---- 点击放大灯箱 ---- */
    const lb = document.createElement('div');
    lb.className = 'cert-lightbox';
    lb.innerHTML = `<button class="lb-close" aria-label="关闭">✕</button>` +
      `<img alt="" draggable="false" /><div class="lb-meta"><h3></h3><p></p></div>`;
    document.body.appendChild(lb);
    const closeLb = () => lb.classList.remove('open');
    lb.addEventListener('click', (e) => { if (e.target === lb || e.target.closest('.lb-close')) closeLb(); });
    lb.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true }); // 灯箱打开时滚轮不透传给页面阻尼
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLb(); });
    function openLb(d) {
      lb.querySelector('img').src = `./src/assets/images/${d.img}`;
      lb.querySelector('img').alt = d.name;
      lb.querySelector('h3').textContent = d.name;
      lb.querySelector('p').textContent = [d.issuer, d.holder ? '持证：' + d.holder : '', d.id ? 'ID: ' + d.id : '', d.date].filter(Boolean).join(' · ');
      lb.classList.add('open');
      badge.style.display = 'none';   // 灯箱打开时隐藏光标徽章
    }

    stage.addEventListener('pointerdown', (e) => {
      if (pid !== null) return;
      hint.classList.add('hide');   // 首次拖拽后提示淡出
      dragging = true; pid = e.pointerId;
      lastMoveT = performance.now();
      lastP = { x: e.clientX, y: e.clientY };
      moved = 0; downCell = findCell(e);
      try { stage.setPointerCapture(pid); } catch (_) { } // 指针未激活（如合成事件）时捕获失败可忽略
      vel.x = vel.y = 0;
      stage.classList.add('dragging');
      badge.classList.add('dragging');   // 徽章变深紫表示按住
      clearTilt();
      kick();
    });
    stage.addEventListener('pointermove', (e) => {
      if (pid === null) { tiltAt(e); return; }   // 未按下：3D 悬浮跟随
      if (e.pointerId !== pid || !dragging) return;
      const now = performance.now();
      const dx = e.clientX - lastP.x, dy = e.clientY - lastP.y;
      moved += Math.abs(dx) + Math.abs(dy);   // 点击判定按原始光标位移，不随倍率放大
      tgt.x += dx * DRAG_SPEED; tgt.y += dy * DRAG_SPEED;   // 画布位移 = 光标位移 × DRAG_SPEED
      const dt = now - lastMoveT;
      if (dt > 0) { vel.x = dx * DRAG_SPEED / dt; vel.y = dy * DRAG_SPEED / dt; }
      lastMoveT = now; lastP = { x: e.clientX, y: e.clientY };
      kick();
    });
    const release = (e) => {
      if (e.pointerId !== pid) return;
      dragging = false; pid = null;
      stage.classList.remove('dragging');   // 松手：荧光绿边框淡出
      badge.classList.remove('dragging');
      vel.x = Math.max(-0.7, Math.min(0.7, vel.x));  // 轻微惯性：限速收紧（配合 0.75 衰减，硬甩最多滑行约 47px）
      vel.y = Math.max(-0.7, Math.min(0.7, vel.y));
      kick();
      // 位移极小视为点击 → 放大该证书
      if (moved < 6 && downCell) { openLb(certs[downCell.idx]); clearTilt(); }
      downCell = null;
    };
    stage.addEventListener('pointerup', release);
    stage.addEventListener('pointercancel', release);

    window.addEventListener('resize', build);
    // 页面隐藏时暂停循环，回前台按需恢复（空闲零 CPU）
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { cancelAnimationFrame(raf); raf = 0; stage.classList.remove('moving'); stage.classList.remove('dragging'); }
      else if (!dragging && (vel.x || vel.y || tgt.x !== sm.x || tgt.y !== sm.y)) kick();
    });

    build();
  }
})();

/* ============================================================
   独特之处（电子创客 / 艺术能力 / 社会责任；
   兴趣爱好已从主界面隐藏，渲染进弹层 #hobbyModal，入口 #hobbyEntry）
   ============================================================ */
(function initUnique() {
  const V = './src/assets/images/';
  const maker = [
    { title: '自动巡航小车', desc: '基于 D2-5 巡线模块的智能循迹小车，搭载红外传感器实现自动巡航，可沿预设路径稳定行驶。', tech: ['D2-5 巡线模块', '红外传感器', '智能循迹'], video: V + 'line-car.mp4', poster: V + 'line-car-poster.webp' },
    { title: '时钟与温度计结合体', desc: '融合电子时钟与温度显示的多功能装置，采用七段数码管显示，实时呈现时间与环境温度。', tech: ['七段数码管', '实时温度传感', '时钟模块'], video: V + 'clock-thermo.mp4', poster: V + 'clock-thermo-poster.webp' },
  ];
  const art = [
    { title: '素描 8 级证书', desc: '中国美术学院社会美术水平考级证书，素描专业捌级。', issuer: 'China Academy of Art', date: '2020-09-17', img: V + 'sketch-cert.webp' },
    { title: '素描头像作品', desc: '采用石墨铅笔绘制的人像素描，注重光影层次与结构表现。', img: V + 'sketch-portrait.webp' },
    { title: '素描静物作品', desc: '静物组合素描练习，运用明暗对比与空间透视，展现物品质感。', img: V + 'sketch-landscape.webp' },
  ];
  const volunteer = [
    { title: '白鹿亭慈善联合会志愿活动', desc: '参与社区志愿者服务，协助组织慈善活动、分发爱心物资，为社区公益事业贡献力量。', detail: '志愿服务', date: '2021-11-28', img: V + 'volunteer-2021.webp' },
    { title: '白鹿亭慈善联合会志愿义工活动', desc: '持续参与社区志愿服务，协助开展公益活动策划与执行，传递温暖与爱心。', detail: '志愿服务', date: '2022-10-03', img: V + 'volunteer-2022.webp' },
  ];
  const hobby = [
    { title: '图寻 / GeoGuessr', sub: '地理反向定位猜测', desc: '通过街景图像进行地理定位推理，结合地标、植被、路标、建筑风格等线索判断位置。', detail: '猜测精度最高可达 5m', video: V + 'geoguessr-video.mp4', poster: V + 'geoguessr-video-poster.webp', hobby: true },
    { title: '街景定位演示', sub: 'GeoGuessr Street View', desc: 'GeoGuessr 街景模式下的典型场景截图，模拟实际游戏中的地理定位推理过程。', video: V + 'geoguessr-streetview.mp4', poster: V + 'geoguessr-streetview-poster.webp', hobby: true },
    { title: '地图定位过程', sub: 'Map Pinpointing', desc: '在世界地图上进行位置猜测并验证猜测结果，展示从推理到定位的完整过程。', video: V + 'geoguessr-pinpoint.mp4', poster: V + 'geoguessr-pinpoint-poster.webp', hobby: true },
    { title: 'Monaco 5K 高分过程', sub: 'GeoGuessr Monaco', desc: '在地图中完成一轮 5000 分的高分对局，完整展示街景观察、地图定位到得分结算的全程。', caption: 'Monaco 5K过程展示', video: V + 'video-project-3.mp4', poster: V + 'video-project-3-poster.webp', hobby: true },
  ];
  // 懒加载视频：进入视口才加载源
  const lazyVideo = (v, poster, cls) =>
    `<video class="${cls}" muted loop playsinline preload="none" poster="${poster}" data-src="${v}"></video>`;

  $('#ufBlocks').innerHTML = `
    <div class="uf-block reveal">
      <div class="uf-title"><span class="ico">🔧</span><h3>电子创客</h3><span>Electronic Maker</span></div>
      <div class="uf-grid">
        ${maker.map((p) => `
          <div class="uf-card liquid-glass">
            <div class="media">${lazyVideo(p.video, p.poster, '')}</div>
            <div class="body"><h4>${p.title}</h4><p class="desc">${p.desc}</p>
            <div class="tags">${p.tech.map((t) => `<span>${t}</span>`).join('')}</div></div>
          </div>`).join('')}
      </div>
    </div>
    <div class="uf-block reveal">
      <div class="uf-title"><span class="ico">🎨</span><h3>艺术能力</h3><span>Artistic Ability</span></div>
      <div class="uf-grid col3">
        ${art.map((a) => `
          <div class="uf-card liquid-glass col3">
            <div class="media"><img data-src="${a.img}" alt="${a.title}" loading="lazy" decoding="async" /></div>
            <div class="body"><h4>${a.title}</h4><p class="desc">${a.desc}</p>
            ${a.issuer ? `<span class="badge-dark">${a.issuer}</span>` : ''}</div>
          </div>`).join('')}
      </div>
      <div class="art-note liquid-glass"><span class="badge-green">美术 × 数字化</span><p>美术功底赋能数字化表达：独立完成个人简历网站的视觉设计及前端搭建，实现「美术素养」与「交互体验」的融合。</p></div>
    </div>
    <div class="uf-block reveal">
      <div class="uf-title"><span class="ico">❤️</span><h3>社会责任</h3><span>Social Responsibility</span></div>
      <div class="uf-grid">
        ${volunteer.map((v) => `
          <div class="uf-card liquid-glass">
            <div class="media"><img data-src="${v.img}" alt="${v.title}" loading="lazy" decoding="async" /></div>
            <div class="body"><h4>${v.title}</h4><p class="desc">${v.desc}</p>
            <div style="display:flex;justify-content:space-between;margin-top:12px;">
              <span class="badge-dark">${v.detail}</span>
              <span style="color:rgba(255,255,255,0.3);font-size:12px;font-family:ui-monospace,monospace;">${v.date}</span>
            </div></div>
          </div>`).join('')}
      </div>
    </div>
    `;

  // 兴趣爱好板块：主界面隐藏，渲染进弹层主体（弹层 display:none 时不触发视频懒加载，
  // 打开后进入视口自动加载播放、关闭后自动暂停，复用下方同一个 IntersectionObserver）
  $('#hobbyModalBody').innerHTML = `
    <div class="uf-grid">
      ${hobby.map((h) => `
        <div class="uf-card liquid-glass hobby">
          <div class="media">${lazyVideo(h.video, h.poster, '')}</div>
          <div class="body"><h4>${h.title}</h4>${h.sub ? `<p class="sub">${h.sub}</p>` : ''}<p class="desc">${h.desc}</p>
          ${h.detail ? `<span class="badge-green">${h.detail}</span>` : ''}</div>
        </div>`).join('')}
    </div>`;

  // 懒加载 + 视口内自动播放
  const videos = $$('.uf-card video');
  const vio = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      const v = en.target;
      if (en.isIntersecting) {
        if (!v.dataset.loaded) { v.src = v.dataset.src; v.load(); v.dataset.loaded = '1'; }
        v.play().catch(() => {});
      } else if (v.dataset.loaded) {
        v.pause();
      }
    });
  }, { rootMargin: '300px 0px' });
  videos.forEach((v) => vio.observe(v));
})();

/* ============================================================
   移动端图片懒加载
   - 初始 DOM 只保留 data-src，防止浏览器在启动页阶段抢先请求整页图片
   - 图片接近视口 500px 时才设置真实 src；桌面端由 Splash 门禁统一处理
   ============================================================ */
(function initMobileLazyImages() {
  if (!IS_MOBILE_VIEW) return;
  const images = document.querySelectorAll('img[data-src]');
  const load = (img) => {
    if (img.dataset.loaded) return;
    img.src = img.dataset.src;
    img.dataset.loaded = '1';
  };
  if (!('IntersectionObserver' in window)) {
    images.forEach(load);
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      load(entry.target);
      observer.unobserve(entry.target);
    });
  }, { rootMargin: '500px 0px' });
  images.forEach((img) => observer.observe(img));
})();

/* ============================================================
   兴趣爱好弹层：入口卡片 ↔ 隐藏板块
   ============================================================ */
(function initHobbyModal() {
  const entry = $('#hobbyEntry'), overlay = $('#hobbyOverlay'), modal = $('#hobbyModal'), closeBtn = $('#hobbyClose');
  if (!entry || !overlay || !modal || !closeBtn) return;
  const open = () => {
    overlay.classList.add('open');
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';   // 锁定背景滚动（触摸/滚动条/键盘）
    // 移动端兴趣视频到此刻才设置真实地址；桌面端复用启动页已完成的缓冲。
    // 直接在用户手势内启动播放，避免隐藏弹层未及时触发 IntersectionObserver。
    modal.querySelectorAll('video').forEach((video) => {
      if (!video.dataset.loaded && video.dataset.src) {
        video.src = video.dataset.src;
        video.preload = 'auto';
        video.dataset.loaded = '1';
        video.load();
      }
      video.play().catch(() => {});
    });
  };
  const close = () => {
    overlay.classList.remove('open');
    modal.classList.remove('open');
    document.body.style.overflow = '';
    modal.querySelectorAll('video').forEach((video) => video.pause());
  };
  entry.addEventListener('click', open);
  entry.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) close();
  });
  // 弹层内的滚轮事件就地消化：阻止冒泡到全局 WheelDamp 阻尼模块，避免背景页面跟着滚动
  // （弹层 body 自身 overflow-y:auto，原生滚动不受影响）
  [overlay, modal].forEach((el) => el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true }));
})();

/* ============================================================
   滚动入场动画
   ============================================================ */
(function initReveal() {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) { en.target.classList.add('in-view'); io.unobserve(en.target); }
    });
  }, { threshold: 0.12 });
  $$('.reveal').forEach((el) => io.observe(el));
})();

/* ============================================================
   全景项目演示（发牌动画）
   ============================================================ */
const dealProjects = [
  { id: '01', title: 'CET-4 在线模拟', link: 'https://cet-4-online.netlify.app/', img: './src/assets/images/cet4.webp' },
  { id: '02', title: '飞机大战', link: 'https://feijidazhan0.netlify.app/', img: './src/assets/images/feijidazhan.webp' },
  { id: '03', title: '小恐龙跑酷', link: 'https://xiaokonglong01.netlify.app/', img: './src/assets/images/xiaokonglong.webp' },
  { id: '04', title: '坦克大战·GSZ', link: 'https://jiostrider.github.io/tank/', img: './src/assets/images/tank.png' },
];
function sizeFor() {
  const w = window.innerWidth;
  if (w < 480) return { cw: 120, ch: 168, sp: 90 };
  if (w < 768) return { cw: 150, ch: 210, sp: 120 };
  return { cw: 200, ch: 280, sp: 300 };
}
const dealCards = [
  { rz: -30, ry: -15, z: 1 },
  { rz: -10, ry: -5, z: 2 },
  { rz: 10, ry: 5, z: 3 },
  { rz: 30, ry: 15, z: 4 },
];
let dealOpen = false;
function openDeal() {
  if (dealOpen) return;
  dealOpen = true;
  const { cw, ch, sp } = sizeFor();
  const arc = -(ch * 0.45);
  const persp = $('#dealPersp');
  persp.innerHTML = dealProjects.map((p, i) => {
    const c = dealCards[i];
    const tx = (i - 1.5) * sp, ty = 0;
    return `
      <a class="deal-card" href="${p.link}" target="_blank" rel="noopener noreferrer"
         style="width:${cw}px;height:${ch}px;z-index:${c.z};"
         data-tx="${tx}" data-ty="${ty}" data-arc="${arc}" data-rz="${c.rz}" data-ry="${c.ry}"
         onclick="event.stopPropagation()">
        <img src="${p.img}" alt="${p.title}" decoding="async" />
        <span class="tag">${p.title}</span>
      </a>`;
  }).join('');
  $('#dealOverlay').classList.add('open');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    persp.querySelectorAll('.deal-card').forEach((el, i) => {
      setTimeout(() => {
        // 阶段 1：上抛 + 半程（dealing）
        el.style.opacity = '1';
        el.style.transform = `translate(calc(-50% + ${+el.dataset.tx * 0.4}px), calc(-50% + ${+el.dataset.arc}px)) rotateZ(${+el.dataset.rz * 0.3}deg) rotateY(${+el.dataset.ry * 0.3}deg) scale(1)`;
        // 阶段 2：落位（done）
        setTimeout(() => {
          el.style.transform = `translate(calc(-50% + ${el.dataset.tx}px), calc(-50% + ${el.dataset.ty}px)) rotateZ(${el.dataset.rz}deg) rotateY(${el.dataset.ry}deg) scale(1)`;
        }, 700);
      }, 100 + i * 150);
    });
  }));
}
function closeDeal() {
  dealOpen = false;
  $('#dealOverlay').classList.remove('open');
  setTimeout(() => $('#dealPersp').innerHTML = '', 400);
}

/* ============================================================
   AI 数字分身（完整移植意图识别 / 情感 / 推理 / IQ 评估引擎）
   ============================================================ */
const KB = {
  person: { name: '高晟哲', englishName: 'Jimmy Gao', title: '物联网工程 · Full Stack AI', summary: '太原理工大学物联网工程本科大一新生。对人工智能应用具有高度热情，擅长运用多模型大语言模型协同工作流。具备系统化逻辑思维，永远保持谦卑与进步的态度。', philosophy: ['系统化逻辑思维', '永远谦卑', '永远进步'] },
  education: { school: '太原理工大学', major: '物联网工程', degree: '本科在读', period: '2026.9 - 2030.6（预计）', label: '211 双一流', courses: ['C语言', '嵌入式底层驱动', '物联网通信技术', '传感器技术', '单片机原理'], description: '本科主修物联网工程，对 C 语言、嵌入式底层驱动有深入理解，具备扎实的硬件与软件结合能力。' },
  skills: { technical: ['C语言', '嵌入式开发', '物联网通信', '传感器技术'], frontend: ['React', 'Vite', 'Tailwind CSS', 'Framer Motion', 'JavaScript', 'HTML/CSS'], ai: ['大语言模型（LLM）', 'AI 工作流编排', '多模型协同', 'Prompt Engineering', 'AI 提效工具'], tools: ['Git', 'VS Code', 'Figma', 'Netlify', 'Chrome DevTools'], summary: '将底层物联网技术与前沿大语言模型结合，具备系统化逻辑思维，且永远保持谦卑与进步的态度。' },
  projects: [
    { title: 'CET-4 英语四级在线模拟', desc: '英语四级在线模拟考试平台，支持听力、阅读、写作全题型练习。' },
    { title: '《飞机大战》', desc: '经典飞行射击游戏，使用 Canvas 实现流畅的弹幕射击体验。' },
    { title: '《小恐龙跑酷》', desc: '像素风格跑酷游戏，致敬 Chrome Dino，支持移动端触控。' },
    { title: '《坦克大战·GSZ战场》', desc: '双人对战坦克游戏，支持键盘操控，可自定义地图布局。' },
  ],
  certificates: [
    { name: '达摩院 AI 培训师认证', issuer: 'DAMO Academy', id: 'AIT260809225938000178' },
  ],
  contact: { phone: atob('MTkyMjk3NzAwOTU='), email: 'wzgsz2008@foxmail.com', github: 'https://github.com/jiostrider', linkedin: 'https://www.linkedin.com/in/shengzhe-gao/' },
  achievements: ['达摩院 AI 培训师认证（DAMO Academy）', '独立开发多款网页应用与游戏', '擅长多模型大语言模型协同工作流', '将 AI 技术应用于学习与创作全流程'],
  hobbies: [{ name: '图寻 / GeoGuessr', description: '通过街景图像进行地理定位推理，结合地标、植被、路标、建筑风格等线索判断位置，猜测精度最高可达 5m。' }],
};
const INTENTS = [
  { intent: 'greeting', kw: ['你好', '您好', '嗨', 'hi', 'hello', 'hey', '早上好', '晚上好', '下午好'], p: 10 },
  { intent: 'education', kw: ['求学', '教育', '大学', '学校', '专业', '物联网', '太原理工', '课程', '学习', '本科', '学业', '在读', 'c语言', '嵌入式', '学历'], p: 8 },
  { intent: 'skills', kw: ['技能', '技术', '擅长', '会什么', '能力', '技术栈', 'stack', '掌握', '熟练', 'react', 'tailwind', '前端', '开发'], p: 8 },
  { intent: 'ai_skills', kw: ['ai', '人工智能', '大模型', 'llm', 'prompt', '提示词', '工作流', '多模型', '协同', '提效', 'ai提效', 'ai工具'], p: 8 },
  { intent: 'projects', kw: ['作品', '项目', 'cet', '四级', '英语', '飞机', '坦克', '恐龙', '跑酷', '游戏', '实战'], p: 7 },
  { intent: 'certificates', kw: ['证书', '认证', '荣誉', '达摩院', 'damo', '培训师', '资质'], p: 7 },
  { intent: 'contact', kw: ['联系', '联系方式', '电话', '手机', '邮箱', 'email', '微信', 'github', 'linkedin', '怎么联系'], p: 7 },
  { intent: 'philosophy', kw: ['理念', '信念', '哲学', '态度', '价值观', '谦卑', '进步', '思维', '逻辑', '信条'], p: 6 },
  { intent: 'achievements', kw: ['成就', '成果', '荣誉', '成绩', '收获', '获得', '奖项'], p: 5 },
  { intent: 'about', kw: ['介绍', '关于', '是谁', '背景', '简介', '个人', '简历', '你是谁', '你是什么', '做什么的'], p: 9 },
  { intent: 'iq_test', kw: ['智商', 'iq', '测试', '评估', '智能', '能力测试', '聪明', '考核'], p: 9 },
  { intent: 'help', kw: ['帮助', '功能', '能做什么', '会做什么', '支持', '指令', '怎么用'], p: 5 },
  { intent: 'emotion', kw: ['心情', '感觉', '开心', '难过', '生气', '焦虑', '压力', '累', '疲惫', '烦恼', '困惑', '迷茫'], p: 9 },
  { intent: 'reasoning', kw: ['为什么', '怎么', '如何', '分析', '推理', '解释', '原因', '逻辑', '思考', '步骤', '方案', '建议'], p: 6 },
  { intent: 'future', kw: ['未来', '计划', '规划', '目标', '梦想', '方向', '打算', '前景', '展望'], p: 5 },
  { intent: 'thanks', kw: ['谢谢', '感谢', '谢谢你', '多谢', '感恩', '辛苦了'], p: 4 },
  { intent: 'hobbies', kw: ['爱好', '兴趣', '图寻', 'geoguessr', '地理', '猜测', '地图', '定位', '反向', '休闲'], p: 6 },
];
function recognize(text, ctx) {
  const lower = text.toLowerCase();
  const scores = INTENTS.map((it) => {
    const hits = it.kw.filter((k) => lower.includes(k)).length;
    return { intent: it.intent, score: it.kw.length ? (hits / it.kw.length) * it.p + hits * 2 : 0 };
  }).sort((a, b) => b.score - a.score);
  if (ctx.lastIntent && scores[0].score < 1) {
    const c = scores.find((s) => s.intent === ctx.lastIntent);
    if (c) c.score += 3;
  }
  return scores[0].score > 0 ? scores[0].intent : 'unknown';
}
function sentiment(text) {
  const l = text.toLowerCase();
  const pos = ['开心', '高兴', '好', '棒', '赞', '厉害', '优秀', '喜欢', '爱', '感谢', '谢谢', 'nice', 'great', 'good', 'happy'];
  const neg = ['难过', '伤心', '累', '疲惫', '焦虑', '压力', '烦', '生气', '失望', '讨厌', '不好', '差', 'sad', 'bad', 'tired', 'angry'];
  const neu = ['了解', '知道', '明白', '嗯', '哦', 'ok', 'okay', '是的', '对', '可以', '好的'];
  const p = pos.filter((w) => l.includes(w)).length;
  const n = neg.filter((w) => l.includes(w)).length;
  const u = neu.filter((w) => l.includes(w)).length;
  if (p > n && p > u) return 'positive';
  if (n > p && n > u) return 'negative';
  return 'neutral';
}
function empathy(sent, intent) {
  const map = {
    positive: { greeting: '很高兴见到你！希望今天的交流能给你带来更多启发 🎯', general: '听到你这么说我很开心！让我们一起探索更多有趣的内容吧。' },
    negative: { general: '听起来你最近可能有些压力。记住，保持谦卑的心态和持续进步的态度，一切都会慢慢好起来的。', education: '学习过程中遇到困难是正常的，重要的是保持系统化的思维方式，一步一步来解决问题。' },
    neutral: { general: '好的，让我来为你提供有价值的信息。' },
  };
  const m = map[sent] || map.neutral;
  return m[intent] || m.general || '';
}
const MEM = { lastIntent: null, lastResponse: null, msgCount: 0 };

function reply(input) {
  const intent = recognize(input, MEM);
  const sent = sentiment(input);
  const emp = empathy(sent, intent);
  let resp = '', showReasoning = false;
  switch (intent) {
    case 'greeting': resp = `你好！我是高晟哲的 AI 数字分身 Jimmy。${MEM.msgCount > 1 ? '又见面了，有什么想了解的？' : '我可以为你介绍他的教育背景、技术能力、项目作品等信息，也可以帮你做 IQ 能力评估。有什么想了解的？'}`; break;
    case 'about': resp = `${KB.person.name}（${KB.person.englishName}），${KB.person.title}。${KB.person.summary}他的核心理念是「${KB.person.philosophy.join('、')}」。`; break;
    case 'education': resp = `${KB.education.description}他就读于${KB.education.school}（${KB.education.label}），${KB.education.major}专业，${KB.education.degree}，预计 ${KB.education.period}。主要课程包括：${KB.education.courses.join('、')}。`; break;
    case 'skills': resp = `他的技术能力分为几个维度：\n\n**技术基础**：${KB.skills.technical.join('、')}\n**前端开发**：${KB.skills.frontend.join('、')}\n**AI 能力**：${KB.skills.ai.join('、')}\n**工具链**：${KB.skills.tools.join('、')}\n\n核心优势：${KB.skills.summary}`; break;
    case 'ai_skills': resp = `在 AI 领域，他具备以下能力：\n\n1. **大语言模型应用**：熟练使用多种 LLM 处理复杂任务\n2. **AI 工作流编排**：将多个 AI 模型组合成高效工作流\n3. **多模型协同**：根据不同任务特点选择最优模型组合\n4. **Prompt Engineering**：精准设计提示词，获得高质量输出\n5. **AI 提效工具**：将 AI 融入日常学习与创作全流程\n\n这体现了他的系统化逻辑思维和持续学习的前沿意识。`; break;
    case 'projects': resp = `他独立开发了以下作品：\n\n${KB.projects.map((p) => `**${p.title}**：${p.desc}`).join('\n')}\n\n这些作品涵盖教育工具、休闲游戏等多种类型，体现了他从概念到上线的全栈开发能力。`; break;
    case 'certificates': resp = `目前获得的认证：\n\n${KB.certificates.map((c) => `**${c.name}**\n颁发机构：${c.issuer}\n证书编号：${c.id}`).join('\n\n')}\n\n这些认证证明了他在 AI 领域的专业能力。`; break;
    case 'contact': resp = `你可以通过以下方式联系他：\n\n📞 电话：${KB.contact.phone}\n📧 邮箱：${KB.contact.email}\n💻 GitHub：${KB.contact.github}\n🔗 LinkedIn：${KB.contact.linkedin}\n\n欢迎随时联系！`; break;
    case 'philosophy': resp = `他的核心信念是「${KB.person.philosophy.join('、')}」。\n\n**系统化逻辑思维**：面对复杂问题，拆解为可执行的步骤，有条不紊地推进。\n**永远谦卑**：保持学习心态，认识到知识的边界，不断向他人学习。\n**永远进步**：持续迭代自己，在每一个项目中追求更好的表现。\n\n这些信念驱动着他不断探索技术前沿。`; break;
    case 'achievements': resp = `他的主要成就包括：\n\n${KB.achievements.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n\n作为一个大一新生，这些成果展现了他超越同龄人的学习能力和实践精神。`; break;
    case 'iq_test':
      showReasoning = true;
      resp = `好的，我将启动 IQ 评估测试。测试将评估以下维度：\n\n1. **自然语言理解**（NLU）\n2. **逻辑推理**（Reasoning）\n3. **知识储备**（Knowledge）\n4. **情感智能**（EQ）\n5. **自适应学习**（Adaptation）\n\n请回复「开始测试」或提出一个具体问题让我解答，我将展示推理过程！`;
      break;
    case 'emotion':
      if (sent === 'negative') resp = `我注意到你似乎有些情绪低落。请记住，每个人都会经历起伏，${KB.person.name}的信念「永远谦卑、永远进步」也提醒我们，困难只是成长的一部分。`;
      else if (sent === 'positive') resp = `感受到你的积极能量！这种心态正是「永远进步」的最好体现。有什么想进一步了解的吗？`;
      else resp = '我理解情绪是复杂而多变的。作为 AI 分身，我会尽力理解你的感受，提供有价值的回应。有什么想聊的吗？';
      break;
    case 'reasoning':
      showReasoning = true;
      if (input.includes('为什么') || input.includes('原因')) {
        resp = `让我用系统化的思维来分析这个问题：\n\n**第一步：问题定义**\n理解你提出的「${input}」\n\n**第二步：信息检索**\n${KB.person.name}的背景和知识体系\n\n**第三步：多角度分析**\n从技术能力、学习经历、实践成果三个维度考量\n\n**第四步：综合判断**\n${KB.person.name}的核心竞争力在于将物联网底层技术与AI应用能力相结合，这种跨领域整合能力在当前技术环境中具有独特价值。`;
      } else {
        resp = `让我用系统化的推理来回答：\n\n**分析过程**：\n1. 明确问题：「${input}」\n2. 检索相关知识库\n3. 结合 ${KB.person.name} 的技术背景\n4. 形成综合回答\n\n${KB.person.name} 具备扎实的物联网工程基础，同时熟练掌握 AI 应用技术，这种「硬件+软件+AI」的复合能力使他能够跨越传统技术边界，创造出独特的解决方案。`;
      }
      break;
    case 'future': resp = `关于未来规划：\n\n**短期目标**：深入学习物联网工程核心课程，同时持续提升 AI 应用能力。\n**中期目标**：将物联网与 AI 深度融合，开发更多有价值的应用。\n**长期愿景**：成为「物联网 × AI」领域的创新者，用技术创造社会价值。\n\n正如他的信条「永远进步」，未来充满无限可能。`; break;
    case 'thanks': resp = '不客气！很高兴能为你提供有价值的信息。如果有任何其他问题，随时可以问我。记得保持「永远谦卑、永远进步」的心态！'; break;
    case 'hobbies': resp = `在兴趣爱好方面，他喜欢**图寻 / GeoGuessr**——一种通过街景图像进行地理反向定位推理的游戏。他结合地标、植被、路标、建筑风格等线索判断位置，猜测精度可达 **5m**，展现了出色的观察力和地理推理能力。`; break;
    case 'help': resp = `我可以帮你了解以下内容：\n\n🔹 **核心优势** - 高晟哲的核心竞争力\n🔹 **物联网基础** - 教育背景与专业技能\n🔹 **AI 提效** - 人工智能应用能力\n🔹 **独立作品** - 实战项目展示\n🔹 **兴趣爱好** - 图寻 GeoGuessr\n🔹 **联系方式** - 电话、邮箱、GitHub、LinkedIn\n🔹 **IQ 评估** - 对我的能力进行多维度测试\n🔹 **情感支持** - 分享心情或困惑\n\n直接输入问题或点击快捷标签即可开始！`; break;
    default:
      if (MEM.lastIntent && MEM.lastResponse) resp = `关于你刚才提到的，${MEM.lastResponse.substring(0, 50)}... 你具体想了解哪方面呢？我可以提供更详细的信息。`;
      else resp = `感谢你的提问！我是一个专注于介绍 ${KB.person.name} 的 AI 数字分身。你可以问我关于他的教育背景、技术能力、项目作品、联系方式等内容，或者让我帮你做 IQ 能力评估。试试点击下方的快捷标签，或者直接输入问题！`;
  }
  if (emp && !resp.includes(emp)) resp = emp + '\n\n' + resp;
  if (showReasoning) {
    const steps = [
      `[1] 理解问题：分析用户输入「${input}」`,
      `[2] 知识检索：从知识库检索相关背景信息`,
      `[3] 逻辑推理：结合 ${KB.person.name} 的能力组合进行综合分析`,
      `[4] 结论生成：形成个性化回答`,
    ];
    resp += '\n\n**推理过程**：\n' + steps.join('\n');
  }
  MEM.lastIntent = intent;
  MEM.lastResponse = resp;
  MEM.msgCount++;
  return resp;
}

/* ---------- AI 抽屉 UI ---------- */
const aiMsgs = $('#aiMsgs'), aiInput = $('#aiInput');
const chips = ['核心优势', '物联网基础', 'AI 提效', '独立作品', '个人理念', 'IQ 评估', '情感支持'];
let iqMode = false, iqStep = 0, iqPass = 0;
const IQ_Q = [
  { q: '请解释"系统化逻辑思维"的含义，并举例说明如何应用。', ok: (r) => r.length > 20 && /步骤|拆解|分析/.test(r) },
  { q: '当用户说"最近有点累"时，你感受到的深层需求是什么？', ok: (r) => r.length > 15 && /情绪|理解|支持|倾听/.test(r) },
  { q: '分析物联网工程专业与AI应用能力之间的关系，说明为什么这种组合具有优势。', ok: (r) => r.length > 30 && /结合|整合|硬件|数据/.test(r) },
  { q: '如果一个人同时具备C语言嵌入式开发和LLM提示工程能力，他最适合做什么？请推理。', ok: (r) => r.length > 20 && /AI|智能|嵌入式/.test(r) },
  { q: '请详细介绍高晟哲的教育背景和技术能力。', ok: (r) => r.includes('太原理工') && r.includes('物联网') && r.length > 40 },
  { q: '列出他独立开发的所有项目，并简要说明每个项目的特点。', ok: (r) => r.includes('CET') && r.includes('飞机') && r.length > 50 },
  { q: '用户说"我觉得自己什么都不会"，请给出一个温暖且有建设性的回应。', ok: (r) => r.length > 20 && /学习|进步|谦卑|成长/.test(r) },
  { q: '用户分享了成功的喜悦，如何回应最能体现共情？', ok: (r) => r.length > 15 && /开心|高兴|祝贺|赞/.test(r) },
  { q: '如果用户多次询问同一主题，你会如何调整回答策略？', ok: (r) => r.length > 20 && /深入|不同角度|细节|之前的/.test(r) },
  { q: '如何根据用户的提问风格调整你的表达方式？', ok: (r) => r.length > 20 && /风格|调整|匹配|适应/.test(r) },
];

function addMsg(role, text) {
  const d = document.createElement('div');
  d.className = 'ai-msg ' + (role === 'user' ? 'me' : 'bot');
  const body = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br/>');
  // 与原版一致：bot 消息带头像图标
  d.innerHTML = role === 'ai' ? `<span class="bot-avatar">🤖</span><span>${body}</span>` : body;
  aiMsgs.appendChild(d);
  aiMsgs.scrollTop = aiMsgs.scrollHeight;
}
function openAI() {
  $('#aiOverlay').classList.add('open');
  $('#aiDrawer').classList.add('open');
  if (!aiMsgs.children.length) {
    addMsg('ai', '你好！我是高晟哲的 AI 数字分身 Jimmy。我具备自然语言理解、逻辑推理、情感智能等能力，可以为你详细介绍他的信息，也欢迎你对我进行 IQ 评估测试！有什么想了解的？');
    $('#aiChips').innerHTML = chips.map((c) => `<button class="ai-chip" onclick="chipAsk('${c}')">${c}</button>`).join('');
  }
  setTimeout(() => aiInput.focus(), 350);
}
function closeAI() {
  $('#aiOverlay').classList.remove('open');
  $('#aiDrawer').classList.remove('open');
}
function chipAsk(c) {
  const map = { '核心优势': '他的核心优势是什么？', '物联网基础': '介绍他的教育背景和物联网专业', 'AI 提效': '他在 AI 提效方面有什么能力？', '独立作品': '他有哪些独立作品？', '个人理念': '他的个人理念是什么？', 'IQ 评估': 'IQ 评估', '情感支持': '我最近有点累' };
  aiInput.value = map[c] || c;
  sendAI();
}
function sendAI() {
  const text = aiInput.value.trim();
  if (!text) return;
  aiInput.value = '';
  addMsg('user', text);

  // IQ 测试流程
  if (iqMode) {
    if (text.includes('结束') || text.includes('停止')) {
      iqMode = false;
      const score = Math.round(80 + (iqPass / IQ_Q.length) * 70);
      addMsg('ai', `评估完成！你共回答了 ${iqPass}/${IQ_Q.length} 道题。\n综合评估 IQ 分数：**${score}**\n\n说明：本评估基于答题质量，反映了自然语言理解、逻辑推理、知识储备、情感智能与自适应学习五个维度的综合水平。`);
      return;
    }
    const passed = IQ_Q[iqStep] ? IQ_Q[iqStep].ok(text) : false;
    if (passed) iqPass++;
    iqStep++;
    addMsg('ai', passed ? '✓ 回答很好，通过了本项评估！' : '✗ 未完全通过，让我们继续下一项。');
    if (iqStep >= IQ_Q.length) {
      iqMode = false;
      const score = Math.round(80 + (iqPass / IQ_Q.length) * 70);
      addMsg('ai', `评估完成！你共通过 ${iqPass}/${IQ_Q.length} 项。\n综合评估 IQ 分数：**${score}**\n\n发送「结束」可随时退出测试。`);
      return;
    }
    setTimeout(() => addMsg('ai', `第 ${iqStep + 1}/${IQ_Q.length} 题：${IQ_Q[iqStep].q}`), 500);
    return;
  }
  if (text.includes('开始测试')) {
    iqMode = true; iqStep = 0; iqPass = 0;
    addMsg('ai', 'IQ 评估已开始！共 10 道题，请认真作答。\n\n第 1 题：' + IQ_Q[0].q);
    return;
  }

  // 思考延迟后回复（模拟 AI 处理）
  const typing = document.createElement('div');
  typing.className = 'ai-msg bot typing';
  typing.innerHTML = '<span class="bot-avatar">🤖</span><span>正在思考...</span>';
  aiMsgs.appendChild(typing);
  aiMsgs.scrollTop = aiMsgs.scrollHeight;
  setTimeout(() => {
    typing.remove();
    addMsg('ai', reply(text));
  }, 600 + Math.random() * 600);
}

/* ============================================================
   初始化
   ============================================================ */
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeAI(); closeDeal(); } });

/* ============================================================
   页脚电话号码防爬：源码中不含明文，首次点击解码显示，再次点击拨号
   ============================================================ */
(function () {
  const link = document.getElementById('telLink');
  if (!link) return;
  const NUM = atob('MTkyMjk3NzAwOTU=');
  link.addEventListener('click', () => {
    if (!link.dataset.revealed) {
      link.dataset.revealed = '1';
      document.getElementById('telNum').textContent = NUM;
      link.href = 'tel:' + NUM;
      link.click(); /* 已显示号码，直接进入拨号 */
    }
  });
})();

/* ============================================================
   打印 / 导出 PDF：视频换海报图、雷达图强制展开
   ============================================================ */
window.addEventListener('beforeprint', () => {
  // 雷达图数据多边形强制为最终展开态（动画未触发时避免打印出退化图形）
  const poly = document.getElementById('dataPoly');
  if (poly && window.__radarTarget) poly.setAttribute('points', window.__radarTarget);
  // 视频用 poster 首帧海报图替代，避免打印空白
  document.querySelectorAll('.uf-card .media video').forEach((v) => {
    const media = v.parentNode;
    if (!media || media.querySelector('.print-video-fallback')) return;
    const img = document.createElement('img');
    img.className = 'print-video-fallback';
    img.alt = '';
    img.src = v.poster || v.dataset.src;
    media.appendChild(img);
  });
});
window.addEventListener('afterprint', () => {
  document.querySelectorAll('.uf-card .media .print-video-fallback').forEach((img) => img.remove());
});

/* ============================================================
   背景视频诊断面板（仅 URL 带 ?bgdebug=1 或 #bgdebug 时启用）
   - 跨浏览器问题定位用：展示 hls.js 实际加载来源、video 状态机、
     媒体事件时间线、hls.js 错误明细；正常访客零开销、不加载
   ============================================================ */
(function bgDebug() {
  if (!/[?#&]bgdebug/.test(location.search + location.hash)) return;
  const video = $('#bgVideo');
  const log = [];
  const push = (m) => { log.unshift(`[${(performance.now() / 1000).toFixed(1)}s] ${m}`); if (log.length > 40) log.pop(); };
  ['playing', 'play', 'pause', 'error', 'stalled', 'waiting', 'canplay', 'canplaythrough',
   'loadeddata', 'loadedmetadata', 'emptied', 'abort', 'suspend', 'ended'].forEach((ev) =>
    video.addEventListener(ev, () =>
      push('video.' + ev + (video.error ? ` (code=${video.error.code} ${video.error.message})` : ''))));
  // 捕获脚本资源加载失败（如 hls.min.js 本地+CDN 全部失败）
  window.addEventListener('error', (e) => {
    if (e.target && e.target.tagName === 'SCRIPT') push('script加载失败: ' + (e.target.src || ''));
  }, true);

  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:rgba(0,0,0,.88);color:#4ade80;font:12px/1.55 Consolas,monospace;padding:10px 12px;border-radius:8px;max-width:460px;white-space:pre-wrap;pointer-events:none;';
  document.body.appendChild(panel);
  (function render() {
    const v = video;
    panel.textContent =
`== 背景视频诊断 ==  在线:${navigator.onLine}
hls.js来源: ${window.__hlsLoadedFrom || '尚未加载成功'}
Hls可用: ${typeof window.Hls !== 'undefined'} / isSupported: ${window.Hls ? Hls.isSupported() : '-'}
video: readyState=${v.readyState} networkState=${v.networkState} paused=${v.paused}
       t=${v.currentTime.toFixed(1)}s size=${v.videoWidth}x${v.videoHeight} muted=${v.muted}
       src=${(v.currentSrc || '').slice(0, 70)}
       err=${v.error ? v.error.code + ':' + v.error.message : 'null'}
hls错误: ${(window.__hlsErrLog || []).length ? '' : '无'}
${(window.__hlsErrLog || []).slice(-5).map((x) => JSON.stringify(x)).join('\n')}
-- 事件时间线(新→旧) --
${log.slice(0, 12).join('\n')}`;
    setTimeout(render, 1000);
  })();
})();

/* ============================================================
   hls.js 按需加载（懒加载）：仅当本地 mp4 播放失败需要远程兜底时才加载
   - 绝大多数访客走本地 mp4 循环（约 2MB），604KB 的 hls.js 无需下载；
     仅在本地视频缺失/播放失败时，才按"本地副本优先 + CDN 逐级兜底"加载：
     本地副本（./src/assets/js/hls.min.js）保证任意网络/离线下行为一致；
     CDN 仅在本地文件缺失时兜底，全部失败则由 Splash 超时兜底放行
   - __hlsLoadState: 0=未加载 1=加载中 2=就绪（并发调用去重）
   ============================================================ */
var __hlsLoadState = 0;
function loadHlsWhenNeeded(cb) {
  if (__hlsLoadState === 2) { cb(); return; }
  if (__hlsLoadState === 1) { document.addEventListener('hls-ready', () => cb(), { once: true }); return; }
  __hlsLoadState = 1;
  const sources = [
    './src/assets/js/hls.min.js',
    'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js',
    'https://unpkg.com/hls.js@1/dist/hls.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.13/hls.min.js',
  ];
  let i = 0;
  (function next() {
    if (i >= sources.length) return; // 全部失败：Splash 超时兜底放行，保持海报静态背景
    const s = document.createElement('script');
    s.src = sources[i++];
    s.onload = () => {
      __hlsLoadState = 2;
      window.__hlsLoadedFrom = s.src;
      document.dispatchEvent(new Event('hls-ready'));
    };
    s.onerror = () => { s.remove(); next(); };
    document.head.appendChild(s);
  })();
}

/* ============================================================
   内联事件迁移：原 HTML 中的 onclick/onkeydown 统一改为
   addEventListener 绑定（行为不变；本脚本以 defer 加载，
   执行时 DOM 已解析完毕，可直接绑定）
   ============================================================ */
(function bindStaticHandlers() {
  // 导航品牌：点击 / 回车回到顶部
  const brand = document.querySelector('.nav-brand');
  if (brand) {
    const toTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });
    brand.addEventListener('click', toTop);
    brand.addEventListener('keydown', (e) => { if (e.key === 'Enter') toTop(); });
  }
  // Hero：打开 AI 数字分身 / 全景项目演示
  const openAIBtn = document.getElementById('openAIBtn');
  if (openAIBtn) openAIBtn.addEventListener('click', () => openAI());
  const openDealBtn = document.getElementById('openDealBtn');
  if (openDealBtn) openDealBtn.addEventListener('click', () => openDeal());
  // 二维码灯箱：点遮罩或 ✕ 关闭，卡片内部点击不冒泡
  const qrLightbox = document.getElementById('qrLightbox');
  if (qrLightbox) {
    qrLightbox.addEventListener('click', (e) => closeQR(e));
    const card = qrLightbox.querySelector('.qr-card');
    if (card) card.addEventListener('click', (e) => e.stopPropagation());
    const qrClose = qrLightbox.querySelector('.qr-close');
    if (qrClose) qrClose.addEventListener('click', () => closeQR());
  }
  // AI 抽屉：关闭按钮 / 发送按钮 / 回车发送
  const aiClose = document.querySelector('.ai-close');
  if (aiClose) aiClose.addEventListener('click', () => closeAI());
  const aiSend = document.querySelector('.ai-send');
  if (aiSend) aiSend.addEventListener('click', () => sendAI());
  const aiInput = document.getElementById('aiInput');
  if (aiInput) aiInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAI(); });
  // 全景项目演示：仅点击空白遮罩处关闭
  const dealOverlay = document.getElementById('dealOverlay');
  if (dealOverlay) dealOverlay.addEventListener('click', (e) => { if (e.target === dealOverlay) closeDeal(); });
})();
