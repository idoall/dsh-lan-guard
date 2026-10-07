/**
 * dsh-lan-guard — the three patches this plugin injects into DSH's served index.
 *
 * The tap runs inside DSH's own web server (`WebServer.tapIndex`), BEFORE
 * compression, so no response body has to be buffered or rewritten on the proxy
 * path. Each patch has its own marker and is idempotent; the switches are read
 * on EVERY index render, so flipping one needs only a page refresh.
 *
 * 1. {@link injectSettingsUnlock} — `__DSH_TRANSPORT__.ownsHost = true`, which is
 *    what makes DSH treat a LAN page as the host's own surface (Settings →
 *    Models works from a phone). Research note: DSH's settings service computes
 *    `persistence = isLoopback ? "host" : "memory"` from the PAGE's own address,
 *    which a reverse proxy cannot change.
 *
 * 2. {@link injectMobileCompat} — the shims measured on 2026-09-28 as
 *    load-bearing for phones: `AbortSignal.any`/`timeout` (Safari < 17.4),
 *    `Promise.withResolvers` (< 17.4) and the `Iterator` global (< 18.4, which
 *    pdf.js dereferences at module top level and takes the whole plugin tree
 *    down with it). DSH's client calls `AbortSignal.any` in
 *    `openRemoteStream`, i.e. on the session-stream path; without it the throw
 *    is re-thrown by `Session.doOpen` and the chat sits on 「载入历史…」 forever,
 *    with no error text at all. Also adds the mobile/PWA metas. Every shim is
 *    installed only when missing, so a modern engine is untouched.
 *
 * 3. {@link injectSocketWatchdog} — closes sockets stuck in CONNECTING and, when
 *    a resume from the background leaves nothing open, reloads the page once.
 *    WebKit has a documented behaviour where `new WebSocket()` stays in
 *    CONNECTING forever after a background resume while HTTP keeps working, and
 *    DSH's own client has no connect timeout, so the page never recovers by
 *    itself.
 */
import type { LanGuardLogger } from '../log.ts'
import { noopLogger } from '../log.ts'

/** The page global DSH's connection client reads its transport facts from. */
export const TRANSPORT_GLOBAL = '__DSH_TRANSPORT__'

/** Page global listing which patches this page actually received (health panel). */
export const PATCHES_GLOBAL = '__DSH_LAN_GUARD__'

/** Marker proving this file already injected the settings unlock. */
export const UNLOCK_MARKER = '/*dsh-lan-guard:settings-unlock*/'

/** Marker proving the mobile compatibility shims were injected. */
export const MOBILE_COMPAT_MARKER = '/*dsh-lan-guard:mobile-compat*/'

/** Marker proving the mobile metas were injected. */
export const MOBILE_META_MARKER = '<!--dsh-lan-guard:mobile-meta-->'

/** Marker proving the socket watchdog was injected. */
export const SOCKET_WATCHDOG_MARKER = '/*dsh-lan-guard:socket-watchdog*/'

/** The subset of DSH's `webServer` service this module needs. */
export interface IndexTapLike {
  tapIndex(transform: (html: string) => string): () => void
}

/** The page-side switches an index render reads. */
export interface IndexPatchSwitches {
  /** Install the `ownsHost` unlock. */
  settingsUnlock(): boolean
  /** Install the mobile compatibility shims. */
  mobileCompat(): boolean
  /** Install the client-side socket watchdog. */
  socketWatchdog(): boolean
  /** Install the narrow-screen scroll correction. */
  mobileScrollFix(): boolean
  /** Un-hide DSH's own turn-navigation rail on narrow screens. */
  mobileTurnRail(): boolean
}

/**
 * The exact head markup that makes the page look like the host's own surface.
 *
 * Written as ES5 with `Object.assign` so it cannot throw on a primitive or a
 * hostile value already sitting on the global, and it never overwrites a
 * property DSH itself put there.
 *
 * @returns one inline `<script>` element.
 */
export function settingsUnlockScript(): string {
  return `<script>${UNLOCK_MARKER}(function(){var t=globalThis.${TRANSPORT_GLOBAL};`
    + `globalThis.${TRANSPORT_GLOBAL}=Object.assign({},t!==null&&typeof t==="object"?t:{},{ownsHost:true});`
    + `globalThis.${PATCHES_GLOBAL}=Object.assign({},globalThis.${PATCHES_GLOBAL},{settingsUnlock:true});`
    + '})()</script>'
}

/** Marker proving the mobile scroll fix was injected. */
export const MOBILE_SCROLL_MARKER = '/*dsh-lan-guard:mobile-scroll*/'

/**
 * The narrow-screen scroll correction (2026-09-28 user report: "聊天区无法上下滑动").
 *
 * Measured facts behind it:
 *
 * - On the SAME iPhone viewport in desktop Chrome the chat column scrolls fine
 *   (a wheel scroll reveals «加载更早»), so the relay and the app are not broken;
 *   the failure is iOS-specific layout/touch behaviour inside DSH's own shell —
 *   whose root layer is `dsh-sc-layer` (`position:fixed`, full height,
 *   `overflow-y:hidden`).
 * - On a phone the symptom is "content is visible, the bottom half is covered by
 *   the fixed composer/goal/quick-reply floats, and the column cannot be dragged".
 *
 * The script is deliberately conservative and ONLY acts when the page as a whole
 * cannot scroll AND it finds a layer that is clipping overflowing content. Then
 * it turns exactly those layers into touch-scrollable ones. A page that can
 * already scroll (every desktop browser, and a healthy phone) is never touched.
 *
 * `?lgdiag=1` appends an on-screen report (and clears itself on reload); that is
 * the diagnostic that made this fix possible without a Mac attached to the
 * phone.
 *
 * @returns one inline `<script>` element.
 */
/**
 * 窄屏高度链修正（2026-09-28 第三次修订，照抄 dsh-mobile 的做法）。
 *
 * 事实（真机 + 官方源码 + 竞品对照）：
 *
 * - 官方外壳在窄屏 iOS 下把内容裁在 `pI_x6G_frame`（实测 clientH 844 /
 *   scrollH 1688），而 conversation 认定的滚动层 `[data-conversation-scroll]`
 *   始终 754/754：内容根本没进它的流。结果：手指拖不动、官方「回到底部」
 *   按钮点了没反应、打开会话也不会自动停到最新消息。
 * - dsh-mobile 能做对，靠的是**高度链**而不是滚动补丁：
 *   `html,body,#root{height:100%;overflow:hidden}` +
 *   shell `height:100dvh` + 主区 `min-height:0`（flex 子项允许收缩）。
 *
 * 因此本脚本只做同一件事，并且**绝不改任何 overflow-y、绝不新建滚动容器、
 * 绝不加自己的按钮**：
 *
 * 1. 给 `html/body/#root` 一个确定高度（`100%`，支持时 `100dvh`）并锁住页面滚动；
 * 2. 沿着「被裁且内容溢出」的那一层，给链上所有 flex/grid 容器补 `min-height:0`；
 * 3. 立刻验证官方认定的滚动层是否真的能滚了：能 → 保留；不能 → **全部撤销**，
 *    页面回到与官方逐字节一致的状态（宁可不动，也不引入第二个滚动层）。
 *
 * 抽屉/遮罩打开时同样先撤销自己（0.4.2 的遮罩事故教训）。
 *
 * @returns one inline `<script>` element.
 */
export function mobileScrollFixScript(): string {
  return `<script>${MOBILE_SCROLL_MARKER}(function(){try{`
    + 'var diag=/[?&]lgdiag/.test(self.location.search);var out=[];'
    + 'function log(s){out.push(s);if(diag)draw()}'
    + 'function draw(){try{var p=document.getElementById("lgsc");'
    + 'if(!p){p=document.createElement("pre");p.id="lgsc";p.style.cssText='
    + '"position:fixed;left:0;top:0;right:0;height:46%;z-index:2147483647;background:rgba(0,0,0,.92);'
    + 'color:#0f0;font:10px/1.3 monospace;padding:6px;margin:0;overflow:auto;white-space:pre-wrap;pointer-events:none";'
    + '(document.body||document.documentElement).appendChild(p)}'
    + 'p.textContent="[lan-guard 手机滚动诊断]"+String.fromCharCode(10)+out.join(String.fromCharCode(10))}catch(e){}}'
    + 'var touched=[];'
    + 'function set(el,prop,val){if(!el)return;try{el.style.setProperty(prop,val,"important");'
    + 'touched.push([el,prop])}catch(e){}}'
    + 'function undoAll(){for(var i=0;i<touched.length;i++){try{touched[i][0].style.removeProperty(touched[i][1])}catch(e){}}touched=[]}'
    + 'function conv(){try{return document.querySelector("[data-conversation-scroll]")}catch(e){return null}}'
    + 'function convScrolls(){var c=conv();return !!c&&c.scrollHeight>c.clientHeight+8}'
    + 'function pageScrolls(){var d=document.documentElement,b=document.body;'
    + 'return (d&&d.scrollHeight>d.clientHeight+8)||(b&&b.scrollHeight>b.clientHeight+8)}'
    + 'function clipping(){var r=[];var all=document.querySelectorAll("div");var lim=Math.min(all.length,5000);'
    + 'for(var i=0;i<lim;i++){var el=all[i];var cs=getComputedStyle(el);'
    + 'if(cs.overflowY!=="hidden"&&cs.overflowY!=="clip")continue;'
    + 'if(el.clientHeight<150)continue;if(el.scrollHeight<=el.clientHeight+8)continue;r.push(el)}'
    + 'r.sort(function(a,b){return (b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight)});return r}'
    + 'function overlayOpen(){'
    + 'try{if(document.querySelector("[aria-modal=true],[role=dialog],[data-conversation-overlay]"))return true;'
    + 'var el=document.elementFromPoint(Math.round(innerWidth*0.92),Math.round(innerHeight*0.45));'
    + 'while(el&&el!==document.body){var cs=getComputedStyle(el);'
    + 'if((cs.position==="fixed"||cs.position==="absolute")&&cs.pointerEvents!=="none"){'
    + 'var r=el.getBoundingClientRect();'
    + 'if(r.width>innerWidth*0.85&&r.height>innerHeight*0.7)return true}'
    + 'el=el.parentElement}}catch(e){}return false}'
    + 'function touchPassThrough(){'
    // iOS：pointer-events:auto 的全屏视觉层（布局的渐变/遮罩层）会吃掉触摸，
    // 内容看得见却拖不动。只对"纯容器"放行：全屏、无按钮/输入、几乎无文本。
    + 'var layers=document.querySelectorAll("div");var lim=Math.min(layers.length,5000);var n=0;'
    + 'for(var i=0;i<lim;i++){var el=layers[i];var cs=getComputedStyle(el);'
    + 'if(cs.position!=="fixed"&&cs.position!=="absolute")continue;'
    + 'if(cs.pointerEvents==="none")continue;'
    + 'var r=el.getBoundingClientRect();'
    + 'if(r.width<innerWidth*0.9||r.height<innerHeight*0.8)continue;'
    + 'if(el.querySelector("button,input,textarea,select,[contenteditable]"))continue;'
    + 'if((el.textContent||"").length>40)continue;'
    + 'el.style.setProperty("pointer-events","none","important");n++}'
    + 'log("touch passthrough layers="+n);'
    + 'return n}'
    // DSH 0.2.0-rc.1 回归：会话内容被官方滚动层**内部**某个 overflow:hidden/clip
    // 的层裁掉，高度传不上去（真机实测：21083px 的内容只换来 336px 可滚范围），
    // 于是"打开会话停不到最新消息、手指也拖不动"。
    // 两条一起改，缺一不可（真机矩阵实测）：
    //   height:auto      —— 让该层长高到内容高度，高度才能回流到官方滚动层；
    //   overflow:visible —— 让该层不再是滚动容器，否则它内部的 sticky 控件会以
    //                       "该层自己的底边"为参照：官方「回到底部」按钮的槽
    //                       （EvIC1a_toBottomSlot，sticky bottom:208px）会从
    //                       屏幕内(y≈514)掉到内容底部(y≈10683)而消失。
    // 实测（同一长会话，滚到中段）：
    //   stock            可滚 336   输入框[588,780] ↓[514,548] 可见
    //   只 height:auto   可滚 20675 输入框[588,780] ↓[10683,10717] 不可见 ✗
    //   height+visible   可滚 20675 输入框[588,780] ↓[538,572] 可见 ✓
    // 绝不新建滚动容器、绝不动滚动层以外的层；以"可滚范围是否真的变大"自检，无效整体回退。
    + 'function fixClip(){'
    + 'var c=conv();if(!c)return false;'
    + 'var list=clipping();var before=c.scrollHeight-c.clientHeight;var n=0;'
    + 'for(var i=0;i<list.length;i++){if(!c.contains(list[i]))continue;'
    + 'set(list[i],"height","auto");set(list[i],"overflow","visible");n++}'
    + 'if(!n)return false;'
    + 'var after=c.scrollHeight-c.clientHeight;'
    + 'log("clip grow layers="+n+" max "+before+"->"+after);'
    + 'if(after<=before+8){undoAll();log("clip grow ineffective -> reverted");return false}'
    + 'return true}'
    + 'function fix(){'
    + 'if(convScrolls()){log("official scroll layer works; done");return true}'
    + 'var list=clipping();var clip=list[0];'
    + 'log("clipping="+list.length+(clip?(" first="+String(typeof clip.className==="string"?clip.className:"")+" "+clip.clientHeight+"/"+clip.scrollHeight):""));'
    + 'var root=document.getElementById("root");'
    + 'set(document.documentElement,"height","100%");'
    + 'set(document.body,"height","100%");set(document.body,"overflow","hidden");'
    + 'set(root,"height","100dvh");set(root,"min-height","0");set(root,"overflow","hidden");'
    + 'var n=clip,d=0;'
    + 'while(n&&n!==document.body&&d<8){var cs=getComputedStyle(n);'
    + 'if(cs.display.indexOf("flex")>=0||cs.display.indexOf("grid")>=0)set(n,"min-height","0");'
    + 'n=n.parentElement;d++}'
    + 'var ok=convScrolls();'
    + 'log("chainFix convScroll="+(conv()?(conv().clientHeight+"/"+conv().scrollHeight):"n/a")+" scrollable="+ok);'
    + 'if(!ok){undoAll();log("ineffective -> reverted (stock page)")}'
    + 'return ok}'
    + 'var done=false,tries=0;'
    + 'function run(){if(done)return;'
    + 'var narrow=self.matchMedia?self.matchMedia("(max-width: 1023px)").matches:false;'
    + 'var mobile=/iPhone|iPad|iPod|Android/i.test(navigator.userAgent||"");'
    + 'log("narrow="+narrow+" mobile="+mobile+" innerH="+innerHeight+" vv="+(self.visualViewport?self.visualViewport.height:"-")+" pageScrolls="+pageScrolls());'
    + 'if(!narrow||!mobile){done=true;return}'
    + 'if(overlayOpen()){undoAll();log("overlay/dialog open -> reverted");return}'
    // 放行必须发生在 convScrolls() 短路之前：官方滚动层"按尺寸可滚"正是
    // "内容看得见却拖不动"的场景（触摸被全屏视觉层吃掉），此时若直接 return，
    // touchPassThrough() 就永远不会执行，Runbook 期望的 layers=N 也打不出来。
    + 'touchPassThrough();'
    // 再修"内容被滚动层内部裁剪层吃掉高度"（0.2.0-rc.1 回归）：它表现为
    // convScrolls() 为真（有溢出）但可滚范围远小于内容实际高度，故必须在这条
    // 短路之前处理，否则同样永远执行不到。
    + 'if(fixClip()){log("clip released -> max="+(conv().scrollHeight-conv().clientHeight));done=true;return}'
    // Long transcripts hydrate after the official scroller has acquired a small
    // scroll range. Keep polling briefly so a late overflow:hidden child is
    // still released instead of treating that intermediate state as healthy.
    + 'if(convScrolls()){log("official scroll layer works; waiting for late clip");return}'
    + 'if(fix())done=true}'
    + 'run();'
    + 'var t=setInterval(function(){tries++;run();if(done||tries>30)clearInterval(t)},1500);'
    + '}catch(e){}})()</script>'
}

/**
 * Insert the narrow-screen scroll correction.
 *
 * @param html - the index body as DSH rendered it.
 * @returns the body with the correction inserted.
 */
export function injectMobileScrollFix(html: string): string {
  if (html.includes(MOBILE_SCROLL_MARKER)) return html
  return insertAfterHead(html, mobileScrollFixScript())
}

/** Marker proving the mobile turn-rail patch was injected. */
export const MOBILE_TURN_RAIL_MARKER = '/*dsh-lan-guard:mobile-turn-rail*/'

/** Id of the injected `<style>`; also what makes the patch re-runnable and revertible. */
export const TURN_RAIL_STYLE_ID = 'lg-turn-rail'

/** Id of the opt-in `?lgdiag=1` report panel of this patch. */
export const TURN_RAIL_DIAG_ID = 'lgtr'

/** Id of the phone preview card the touch layer renders. */
export const TURN_RAIL_CARD_ID = 'lg-turn-card'

/**
 * The phone-only touch layer for the turn rail.
 *
 * The official rail is a HOVER design: the preview bubble is driven by
 * `onPointerMove` / `onFocus` on each mark, so on a touch screen it can never
 * be read — a tap goes straight to `onClick` (navigate) and there is no hover
 * state at all. Measured 2026-10-06 on DSH 0.2.1-alpha.1 / iPhone viewport:
 * the marks are 28×10px with the pitch locked to 10px inside DSH's own
 * JavaScript, so "tap the right one" is also a precision problem.
 *
 * This layer therefore ADDS a gesture instead of changing the existing one:
 *
 * - a plain tap still does exactly what it did (the official click navigates);
 * - holding a mark for ~320ms opens a readable card with that turn's own
 *   preview text (prompt + response), pulled from the official component by
 *   dispatching its own pointermove signal — the same signal desktop hover uses;
 * - once the hold has entered scrub mode, sliding up/down continuously selects
 *   the mark under the finger and refreshes the card, like desktop hover;
 *   lingering at either rail edge auto-scrolls through virtualised marks;
 * - a quick drag before the hold timer expires manually scrolls the rail, so
 *   ordinary rail scrolling remains available while the scrub gesture owns touch;
 * - the click that a held touch still emits is swallowed once, so holding never
 *   navigates by accident.
 *
 * Every entry point is wrapped, and any failure leaves the rail exactly as the
 * official code left it. Rendered in DSH's own tokens so light/dark follow.
 *
 * @returns the ES5 body of the touch layer; callers embed it in the payload.
 */
export function mobileTurnRailTouchScript(): string {
  return `
/* --- touch preview layer: hovering is not a gesture a phone has --- */
(function(){
  if(!(S.matchMedia&&S.matchMedia('(pointer: coarse)').matches))return;
  var CARD_ID="${TURN_RAIL_CARD_ID}";
  var card=null,titleEl=null,bodyEl=null,jumpEl=null,prevEl=null,nextEl=null,closeEl=null;
  var nav=null,mark=null,armed=false,scrubbing=false,dragScrolling=false;
  var armY=0,lastY=0,timer=0,pointerId=null,captureNode=null,scrubDir=0,scrubRaf=0;
  function one(sel,root){try{return (root||doc).querySelector(sel)}catch(e){return null}}
  function navOf(node){try{return node&&node.closest?node.closest(SEL):null}catch(e){return null}}
  // Official TurnNavigator marks carry data-index; card controls do not.
  function marks(){return nav?nav.querySelectorAll("button[data-index]"):[]}
  function el(tag,style,text){
    var node=doc.createElement(tag);
    if(style)node.style.cssText=style;
    if(text)node.textContent=text;
    return node;
  }
  var BTN="border:0;border-radius:9px;font:inherit;font-weight:600;min-height:38px;"
    +"background:var(--dsw-alias-fill-tsp-secondary,rgba(0,0,0,.06));"
    +"color:var(--dsw-alias-label-primary,#111);pointer-events:auto;padding:0 10px";
  function build(){
    if(card)return;
    // Anchor in the official rail, not document.body: iOS Chrome/WebKit can
    // choose a surprising coordinate space for a body-level fixed layer after
    // an edge gesture. The rail itself is already on-screen, so right:100% is
    // a stable leftward anchor. Width and top are clamped in placeCard().
    card=el("div",'position:absolute;right:calc(100% + 8px);top:0;min-width:0;z-index:10;display:none;'
      +"box-sizing:border-box;max-height:calc(100vh - 24px);overflow-y:auto;padding:10px 12px 12px;border-radius:14px;pointer-events:none;"
      +"background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);"
      +"box-shadow:var(--dsw-elevation-panel,0 10px 30px rgba(0,0,0,.22));"
      +"border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));"
      +'font:13px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB",sans-serif');
    card.id=CARD_ID;
    var head=el("div","display:flex;align-items:flex-start;gap:8px");
    titleEl=el("div","flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap");
    closeEl=el("button",BTN+"min-width:34px;padding:0 8px;flex:none","✕");
    closeEl.type="button";
    head.appendChild(titleEl);head.appendChild(closeEl);
    bodyEl=el("div","margin-top:4px;color:var(--dsw-alias-label-secondary,#666);"
      +"white-space:pre-wrap;word-break:break-word;overflow:hidden;"
      +"display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:5");
    var row=el("div","display:flex;gap:8px;margin-top:8px");
    prevEl=el("button",BTN+"flex:none;min-width:44px","◀");
    nextEl=el("button",BTN+"flex:none;min-width:44px","▶");
    jumpEl=el("button",BTN+"flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--dsw-alias-state-business-primary,#3964fe);color:#fff");
    prevEl.type="button";nextEl.type="button";jumpEl.type="button";
    row.appendChild(prevEl);row.appendChild(jumpEl);row.appendChild(nextEl);
    card.appendChild(head);card.appendChild(bodyEl);card.appendChild(row);
    // nav is the on-screen official rail. Keeping the card in this local
    // containing block avoids iOS Chrome's body-level fixed positioning path.
    if(nav)nav.appendChild(card);else (doc.body||doc.documentElement).appendChild(card);
    closeEl.addEventListener("click",function(ev){ev.stopPropagation();hide()});
    prevEl.addEventListener("click",function(ev){ev.stopPropagation();step(-1)});
    nextEl.addEventListener("click",function(ev){ev.stopPropagation();step(1)});
    jumpEl.addEventListener("click",function(ev){
      ev.stopPropagation();ev.preventDefault();
      var m=mark;hide();
      if(m){try{m.click()}catch(e){}}
    });
  }
  function hide(){
    armed=false;scrubbing=false;dragScrolling=false;clearTimeout(timer);stopAuto();release();mark=null;
    if(card)card.style.display="none";
    try{if(nav)nav.removeAttribute("data-lg-turn-card")}catch(e){}
  }
  /** The official bubble is what we read; it must not also float under the finger. */
  function own(){try{if(nav)nav.setAttribute("data-lg-turn-card","1")}catch(e){}}
  /**
   * Place inside the visible rail's local coordinate system, then clamp vertically
   * using the card's actual rect. This is intentionally independent of body-level
   * fixed positioning / visual viewport offsets, which differ in iOS Chrome.
   */
  function placeCard(){
    if(!card||!nav)return;
    var nr=nav.getBoundingClientRect(),vw=S.innerWidth||320,vh=S.innerHeight||568,safe=12;
    // right:calc(100% + 8px) means the card's right edge sits 8px left of
    // the rail. Limit its width so its left edge still has the safe margin.
    var width=Math.min(320,Math.max(0,nr.left-safe-8));
    card.style.width=width+"px";
    var target=lastY<vh*0.45?Math.round(vh*0.45):76;
    card.style.top=Math.round(target-nr.top)+"px";
    card.style.transform="translate3d(0,0,0)";
    try{requestAnimationFrame(fitCard)}catch(e){fitCard()}
  }
  function fitCard(){
    if(!card||card.style.display==="none"||!nav)return;
    var vh=S.innerHeight||568,safe=12,r=card.getBoundingClientRect(),dy=0;
    if(r.top<safe)dy=safe-r.top;
    else if(r.bottom>vh-safe)dy=vh-safe-r.bottom;
    if(dy){
      var top=Number.parseFloat(card.style.top)||0;
      card.style.top=Math.round(top+dy)+"px";
    }
  }
  function paint(){
    if(!card||!mark)return;
    var label="";
    try{label=mark.getAttribute("aria-label")||""}catch(e){}
    var tip=nav?one('[role="tooltip"]',nav):null;
    var prompt="",reply="";
    if(tip&&tip.children){
      if(tip.children[0])prompt=tip.children[0].textContent||"";
      if(tip.children[1])reply=tip.children[1].textContent||"";
    }
    titleEl.textContent=prompt||label||"轮次";
    bodyEl.textContent=reply;
    bodyEl.style.display=reply?"block":"none";
    jumpEl.textContent=label||"跳转";
    card.style.display="block";
    placeCard();
    own();
  }
  /**
   * Ask the OFFICIAL component to render its preview without focusing the mark.
   *
   * focus({preventScroll:true}) looks harmless in Chromium, but iOS Chrome
   * is WebKit: WebKit can still scroll a focused right-edge button into view,
   * shifting the visual viewport right and leaving the left edge off-screen.
   * The desktop component already accepts pointermove as its hover signal,
   * so dispatch that bubbling event instead. It produces the same tooltip text
   * without asking the browser to move focus or scroll anything into view.
   */
  function previewMark(node){
    if(!node)return;
    mark=node;
    try{
      var r=node.getBoundingClientRect();
      if(typeof S.PointerEvent==="function"){
        node.dispatchEvent(new S.PointerEvent("pointermove",{
          bubbles:true,cancelable:false,pointerType:"touch",clientX:r.left+r.width/2,clientY:r.top+r.height/2
        }));
      }else if(typeof S.Event==="function"){
        node.dispatchEvent(new S.Event("pointermove",{bubbles:true}));
      }
    }catch(e){}
    paint();
    // React commits the official tooltip on a later frame; re-read once it has.
    try{requestAnimationFrame(function(){requestAnimationFrame(function(){
      if(card&&card.style.display!=="none"&&mark===node)paint()
    })})}catch(e){}
  }
  function step(dir){
    var all=marks(),i=-1,k=0;
    for(k=0;k<all.length;k++){if(all[k]===mark){i=k;break}}
    var j=i+dir;
    if(j>=0&&j<all.length){previewMark(all[j]);return}
    var sc=nav?nav.firstElementChild:null;
    if(sc){sc.scrollTop+=dir*30;try{requestAnimationFrame(function(){
      var l2=marks();if(!l2.length)return;
      previewMark(dir<0?l2[l2.length-1]:l2[0]);
    })}catch(e){}}
  }
  function railScroller(){return nav?nav.firstElementChild:null}
  function markAt(y){
    var all=marks(),best=null,distance=Infinity,i=0;
    for(i=0;i<all.length;i++){
      var r=all[i].getBoundingClientRect();
      if(y>=r.top&&y<=r.bottom)return all[i];
      var d=Math.abs(y-(r.top+r.bottom)/2);
      if(d<distance){distance=d;best=all[i]}
    }
    return best;
  }
  function scrollRail(delta){
    var sc=railScroller();
    if(!sc)return;
    sc.scrollTop=Math.max(0,(sc.scrollTop||0)+delta);
  }
  function capture(node,ev){
    captureNode=node;
    pointerId=typeof ev.pointerId==="number"?ev.pointerId:null;
    try{if(pointerId!==null&&typeof node.setPointerCapture==="function")node.setPointerCapture(pointerId)}catch(e){}
  }
  function release(){
    try{if(captureNode&&pointerId!==null&&typeof captureNode.releasePointerCapture==="function")captureNode.releasePointerCapture(pointerId)}catch(e){}
    captureNode=null;pointerId=null;
  }
  function stopAuto(){
    scrubDir=0;
    if(scrubRaf){clearTimeout(scrubRaf);scrubRaf=0}
  }
  function autoScroll(){
    if(!scrubbing||!scrubDir){scrubRaf=0;return}
    var sc=railScroller();
    if(sc){
      var before=sc.scrollTop||0;
      sc.scrollTop=Math.max(0,before+scrubDir*10);
      if((sc.scrollTop||0)===before){stopAuto();return}
      var next=markAt(lastY);
      if(next&&next!==mark)previewMark(next);
    }
    scrubRaf=setTimeout(autoScroll,16)
  }
  function updateAuto(y){
    if(!nav)return;
    var r=nav.getBoundingClientRect(),edge=30,dir=0;
    if(y<r.top+edge)dir=-1;
    else if(y>r.bottom-edge)dir=1;
    if(dir===scrubDir)return;
    stopAuto();scrubDir=dir;
    if(dir)scrubRaf=setTimeout(autoScroll,16)
  }
  function swallowNextClick(){
    var handler=function(ev){
      try{if(card&&card.contains(ev.target))return}catch(e){}
      try{ev.stopPropagation();ev.preventDefault()}catch(e){}
      try{doc.removeEventListener("click",handler,true)}catch(e){}
    };
    try{doc.addEventListener("click",handler,true)}catch(e){}
    setTimeout(function(){try{doc.removeEventListener("click",handler,true)}catch(e){}},500);
  }
  function open(node,ev){
    nav=navOf(node)||nav;
    if(!nav)return;
    armed=false;scrubbing=true;dragScrolling=false;
    lastY=typeof ev.clientY==="number"?ev.clientY:armY;
    build();previewMark(node);capture(node,ev);
    log("turn scrub start: "+(node.getAttribute("aria-label")||""));
  }
  function onDown(ev){
    try{
      if(card&&card.style.display==="block"&&!card.contains(ev.target))hide();
      var node=ev.target;
      // Card controls live inside nav for stable iOS positioning; they are not
      // rail marks and must keep their ordinary click behaviour.
      if(card&&card.contains(node))return;
      if(!node||node.tagName!=="BUTTON"||node.getAttribute("data-index")===null)return;
      var found=navOf(node);
      if(!found)return;
      nav=found;armed=true;scrubbing=false;dragScrolling=false;
      armY=ev.clientY;lastY=ev.clientY;capture(node,ev);
      clearTimeout(timer);
      timer=setTimeout(function(){if(!armed)return;open(node,ev)},320);
    }catch(e){}
  }
  function onMove(ev){
    try{
      if(pointerId!==null&&typeof ev.pointerId==="number"&&ev.pointerId!==pointerId)return;
      var y=ev.clientY;
      if(armed){
        if(Math.abs(y-armY)<=16)return;
        armed=false;dragScrolling=true;clearTimeout(timer);
      }
      if(dragScrolling){
        try{ev.preventDefault()}catch(e){}
        scrollRail(lastY-y);lastY=y;return;
      }
      if(!scrubbing)return;
      try{ev.preventDefault()}catch(e){}
      lastY=y;
      var next=markAt(y);
      if(next&&next!==mark)previewMark(next);
      updateAuto(y);
    }catch(e){}
  }
  function finish(ev){
    try{
      if(pointerId!==null&&typeof ev.pointerId==="number"&&ev.pointerId!==pointerId)return;
      clearTimeout(timer);
      if(scrubbing||dragScrolling)swallowNextClick();
      armed=false;scrubbing=false;dragScrolling=false;stopAuto();release();
    }catch(e){}
  }
  function cancel(){
    // iOS cancels the pointer stream when it decides to run a native gesture
    // (a text selection or a system drag). The click it then emits still belongs
    // to the gesture we owned, and it can land on whatever is underneath — on a
    // phone that is how a drag could reach the composer's attach control. Swallow
    // it exactly as pointerup does; a plain tap never reaches this branch.
    if(scrubbing||dragScrolling)swallowNextClick();
    armed=false;scrubbing=false;dragScrolling=false;clearTimeout(timer);stopAuto();release();
  }
  /**
   * A drag that begins on the rail can end as a file drop somewhere else, and
   * DSH's attachment view reacts to any drag carrying a Files payload with its upload
   * affordance. Refuse the drag at its source; events outside the rail are left
   * alone so normal selection and dragging keep working.
   */
  /**
   * touch-action alone was not enough on WebKit: with the finger on a mark the
   * browser could still take the vertical drag after its slop threshold, which
   * pans the page and can fire pull-to-refresh mid-scrub. A non-passive
   * touchmove listener lets us refuse that outright for the duration of a
   * gesture that began on the rail. Touches anywhere else are never touched, and
   * a multi-finger touch is left alone so pinch still works.
   */
  function blockTouch(ev){
    try{
      if(pointerId===null)return;
      if(ev.touches&&ev.touches.length>1)return;
      if(!(armed||scrubbing||dragScrolling))return;
      if(!navOf(ev.target))return;
      ev.preventDefault();
    }catch(e){}
  }
  function blockDrag(ev){
    try{
      var node=ev.target;
      if(node&&navOf(node)){ev.preventDefault();ev.stopPropagation()}
    }catch(e){}
  }
  doc.addEventListener("touchmove",blockTouch,{capture:true,passive:false});
  doc.addEventListener("dragstart",blockDrag,true);
  doc.addEventListener("selectstart",blockDrag,true);
  doc.addEventListener("pointerdown",onDown,true);
  doc.addEventListener("pointermove",onMove,true);
  doc.addEventListener("pointerup",finish,true);
  doc.addEventListener("pointercancel",cancel,true);
  log("touch preview scrub layer ready");
})();
`
}

/**
 * Un-hide DSH's own turn-navigation rail on narrow screens (opt-in, default OFF).
 *
 * The rail is NOT missing on a phone — it is rendered, virtualised and wired up,
 * and exactly one official rule hides it:
 * `@container (max-width: 900px) { .frame { display: none } }` in
 * `ui-chat/src/client/chat/TurnNavigator.module.css` (the container is the chat
 * frame, ~327px wide on a 390px phone). Measured 2026-10-06 against
 * DSH 0.2.1-alpha.1: the `<nav>` is in the DOM with `display:none` and the
 * virtualiser renders zero marks until something un-hides it; after a
 * `display:block` override the rail comes up fully working (marks, active mark,
 * load-and-jump) with no page errors.
 *
 * Why a stylesheet and not a reimplementation: the turn data
 * (`ui-chat`'s `navigation.items()`) is package-internal, so a plugin cannot
 * rebuild the rail — but it does not have to. Un-hiding reuses the official
 * component, its history paging, its active-mark follow and its previews.
 *
 * Deliberately conservative, in the same spirit as the scroll fix:
 *
 * - the override lives in a `@media (max-width: 1023px)` block, so a desktop
 *   window is never touched;
 * - the selector is attribute-based (`nav[aria-label="轮次导航"]` /
 *   `"Turn navigation"`) plus one structural fallback, because a CSS-module
 *   class name is hashed; the labelled rule nudges the rail into the chat
 *   frame's right gutter (`right:4px`, `width:28px`) so it does not overlap the
 *   message column;
 * - it SELF-CHECKS: if the rail is found but stays invisible while the override
 *   is applied, the style is removed again and the page is left byte-identical
 *   to stock (`mobileTurnRail: "reverted"` in the page's patch ledger);
 * - its only custom interaction is the coarse-pointer card/scrub layer: it
 *   listens inside the official rail, sends the same pointermove signal the
 *   desktop hover handler consumes, and delegates actual navigation back to
 *   the official mark click. It never adds a second conversation scroller or
 *   changes `html`, `body`, or `#root`.
 *
 * Known limit: the rail's mark pitch is fixed at 10px in JavaScript
 * (`TURN_SPACING_PX`, `measureElement: () => 10`), so CSS cannot grow the 28×10px
 * marks into 44px touch targets without making neighbours overlap. That is why
 * this patch ships a second, phone-only half — {@link mobileTurnRailTouchScript}
 * — which gives the rail a gesture it can actually be operated with (hold to
 * preview, steppers to pick the exact turn) instead of relying on precision.
 *
 * The rail itself only ever moves inside the chat frame's right gutter: at
 * `right:4px` / `width:28px` it starts exactly where the message column ends, so
 * it can never cover text.
 *
 * `?lgdiag=1` adds a small report panel (`#lgtr`) that survives a phone with no
 * attached debugger.
 *
 * @returns one inline `<script>` element.
 */
export function mobileTurnRailScript(): string {
  return `<script>${MOBILE_TURN_RAIL_MARKER}(function(){try{`
    + 'var S=self,doc=document;'
    + `var flags=globalThis.${PATCHES_GLOBAL};`
    + 'if(flags&&flags.mobileTurnRail===true)return;'
    + `globalThis.${PATCHES_GLOBAL}=Object.assign({},flags,{mobileTurnRail:true});`
    + 'var diag=false;try{diag=/[?&]lgdiag/.test((S.location&&S.location.search)||"")}catch(e){}'
    + 'var lines=[];'
    + 'function log(s){lines.push(s);if(!diag)return;try{var p=doc.getElementById("' + TURN_RAIL_DIAG_ID + '");'
    + 'if(!p){p=doc.createElement("pre");p.id="' + TURN_RAIL_DIAG_ID + '";p.style.cssText='
    + '"position:fixed;left:0;bottom:0;right:0;max-height:30%;z-index:2147483646;background:rgba(0,0,0,.9);'
    + 'color:#7cf;font:10px/1.3 monospace;padding:6px;margin:0;overflow:auto;white-space:pre-wrap;pointer-events:none";'
    + '(doc.body||doc.documentElement).appendChild(p)}'
    + 'p.textContent="[lan-guard 轮次导航诊断]"+String.fromCharCode(10)+lines.join(String.fromCharCode(10))}catch(e){}}'
    // The official rail is a <nav> whose only stable attribute is its aria-label,
    // which DSH localises; the structural rule below survives a rename.
    + 'var SEL="nav[aria-label=\\"轮次导航\\"],nav[aria-label=\\"Turn navigation\\"]";'
    + 'if(!doc.getElementById("' + TURN_RAIL_STYLE_ID + '")){'
    + 'var st=doc.createElement("style");st.id="' + TURN_RAIL_STYLE_ID + '";'
    + 'st.appendChild(doc.createTextNode("@media (max-width: 1023px){"+SEL'
    // Phones: the rail cannot move further inwards than the chat frame's right
    // gutter (the transcript column starts there), so it takes the whole gutter
    // (28px at right:4px) and trades the last 2px for a wider target. The tick
    // grows 2px -> 3px because a hairline is unreadable on a phone.
    + '+"{display:block!important;right:4px!important;width:28px!important;'
    + 'touch-action:none!important;-webkit-touch-callout:none;'
    // A native drag started on the rail can end as a file drop: DSH's attachment
    // view listens document-wide and activates whenever a drag carries `Files`
    // (ui-attachment/drop-events.ts). On a phone that surfaces as the upload
    // affordance appearing mid-gesture, so no drag may begin here.
    + '-webkit-user-drag:none;user-select:none;-webkit-user-select:none;'
    + 'overscroll-behavior:contain!important}"'
    // The finger lands on a MARK, a plain button with touch-action:auto, and
    // official CSS sets no touch-action anywhere inside the rail. WebKit then
    // resolves the gesture from that descendant, hands the vertical drag to the
    // page after a small slop, and the resulting overscroll fires pull-to-refresh
    // mid-scrub (measured on device: the card advances ~2 ticks, then the whole
    // page drags/refreshes). Cover the whole subtree, and make the phone stop
    // treating a downward drag at scrollTop 0 as a reload.
    + '+"nav[aria-label=\\"轮次导航\\"] *,nav[aria-label=\\"Turn navigation\\"] *'
    + '{touch-action:none!important;overscroll-behavior:contain!important}"'
    + '+"html,body{overscroll-behavior-y:none!important}"'
    + '+"nav[aria-label=\\"轮次导航\\"] button[data-index]::before,'
    + 'nav[aria-label=\\"Turn navigation\\"] button[data-index]::before{height:3px!important}"'
    + '+"nav[aria-label=\\"轮次导航\\"][data-lg-turn-card] [role=\\"tooltip\\"],'
    + 'nav[aria-label=\\"Turn navigation\\"][data-lg-turn-card] [role=\\"tooltip\\"]{display:none!important}"'
    // While the card is open the official component marks the hovered tick with
    // its `markPreview` class, whose resting style is a 0.9-scale grey hairline —
    // invisible under a finger. Promote it to a full-length brand-coloured bar so
    // the user can SEE the selection follow the drag (the black active tick keeps
    // showing where the transcript actually is).
    + '+"nav[aria-label=\\"轮次导航\\"][data-lg-turn-card] button[class*=\\"_markP\\"]::before,'
    + 'nav[aria-label=\\"Turn navigation\\"][data-lg-turn-card] button[class*=\\"_markP\\"]::before{'
    + 'transform:translateY(-50%) scaleX(1)!important;'
    + 'background:var(--dsw-alias-state-business-primary,#3964fe)!important;'
    + 'opacity:1!important}"'
    // Structural fallback: the chat frame is the div holding both the rail slot
    // and the transcript root; display-only, so a stray match is a no-op.
    + '+"div:has(>div [data-chat-flow])>div>nav{display:block!important}"+"}"));'
    + '(doc.head||doc.documentElement).appendChild(st)}'
    + 'var narrow=false;try{narrow=!!(S.matchMedia&&S.matchMedia("(max-width: 1023px)").matches)}catch(e){}'
    + 'log("narrow="+narrow);'
    + 'var tries=0,misses=0,done=false;'
    + 'function rail(){try{return doc.querySelector(SEL)}catch(e){return null}}'
    + 'function visible(n){try{var cs=getComputedStyle(n),r=n.getBoundingClientRect();'
    + 'return cs.display!=="none"&&r.width>1&&r.height>1}catch(e){return false}}'
    + 'function revert(){try{var s=doc.getElementById("' + TURN_RAIL_STYLE_ID + '");'
    + 'if(s&&s.parentNode)s.parentNode.removeChild(s)}catch(e){}'
    + `globalThis.${PATCHES_GLOBAL}=Object.assign({},globalThis.${PATCHES_GLOBAL},{mobileTurnRail:"reverted"});`
    + '}'
    + 'function run(){if(done)return;'
    // Only a narrow page can be judged: on a wide one the official container
    // query is not what hides anything, so leaving the rail alone is correct.
    + 'if(!narrow){done=true;return}'
    + 'var n=rail();'
    + 'if(!n){if(++tries>8){log("no turn rail yet (style kept for the next session)");done=true}return}'
    + 'if(visible(n)){var r=n.getBoundingClientRect();'
    + 'log("turn rail visible "+Math.round(r.width)+"x"+Math.round(r.height)+" at x"+Math.round(r.x));'
    + 'done=true;return}'
    + 'if(++misses>=3){log("override lost -> reverted (stock page)");revert();done=true}}'
    + 'log("style installed");'
    + 'run();'
    + 'var t=setInterval(function(){if(done){clearInterval(t);return}run()},1500);'
    // The phone interaction layer is installed last and in its own guard: a
    // failure there must never cost the rail itself.
    + 'try{' + mobileTurnRailTouchScript() + '}catch(e){}'
    + '}catch(e){}})()</script>'
}

/**
 * Insert the narrow-screen turn-rail override.
 *
 * @param html - the index body as DSH rendered it.
 * @returns the body with the override inserted.
 */
export function injectMobileTurnRail(html: string): string {
  if (html.includes(MOBILE_TURN_RAIL_MARKER)) return html
  return insertAfterHead(html, mobileTurnRailScript())
}

/**
 * The mobile compatibility shims, in one inline script.
 *
 * Every branch is guarded by a `typeof` check, so a browser that already has
 * the API (or a future DSH that installs its own shim first) is untouched, and
 * the whole thing is wrapped in `try` so a hostile environment cannot break the
 * remaining scripts.
 *
 * @returns one inline `<script>` element.
 */
export function mobileCompatScript(): string {
  return `<script>${MOBILE_COMPAT_MARKER}(function(){try{`
    // AbortSignal.any — Safari 17.4+. DSH's stream open calls it on every
    // logical stream, so its absence breaks the session transcript.
    + 'var S=self.AbortSignal;'
    + 'if(S&&typeof S.any!=="function"){S.any=function(signals){'
    + 'var list=Array.prototype.slice.call(signals||[]);var c=new self.AbortController();'
    + 'var i;for(i=0;i<list.length;i++){if(list[i]&&list[i].aborted){'
    + 'try{c.abort(list[i].reason)}catch(e){c.abort()}return c.signal}}'
    + 'var off=function(ev){var src=ev&&ev.target?ev.target:ev;'
    + 'for(var j=0;j<list.length;j++){try{list[j].removeEventListener("abort",off)}catch(e){}}'
    + 'try{c.abort(src?src.reason:undefined)}catch(e){c.abort()}};'
    + 'for(i=0;i<list.length;i++){try{list[i].addEventListener("abort",off,{once:true})}catch(e){}}'
    + 'return c.signal}}'
    // AbortSignal.timeout — Safari 16+; cheap to have everywhere.
    + 'if(S&&typeof S.timeout!=="function"){S.timeout=function(ms){var c=new self.AbortController();'
    + 'setTimeout(function(){try{c.abort(new Error("The operation timed out."))}catch(e){c.abort()}},'
    + 'Math.max(0,Number(ms)||0));return c.signal}}'
    // Promise.withResolvers — Safari 17.4+; DSH's boot inline script uses it and
    // several client plugins call it at runtime.
    + 'if(typeof Promise!=="undefined"&&typeof Promise.withResolvers!=="function"){'
    + 'Promise.withResolvers=function(){var resolve,reject;'
    + 'var promise=new Promise(function(res,rej){resolve=res;reject=rej});'
    + 'return{promise:promise,resolve:resolve,reject:reject}}}'
    // Iterator — Safari 18.4+. pdf.js patches Iterator.prototype at module top
    // level; without the global it throws and the whole plugin tree fails.
    // Grafting the real %IteratorPrototype% keeps that patch meaningful.
    + 'if(typeof self.Iterator==="undefined"){var proto=null;'
    + 'try{proto=Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()))}catch(e){proto=null}'
    + 'var Shim=function Iterator(){};if(proto){Shim.prototype=proto}self.Iterator=Shim}'
    + `globalThis.${PATCHES_GLOBAL}=Object.assign({},globalThis.${PATCHES_GLOBAL},{mobileCompat:true});`
    + '}catch(e){}})()</script>'
}

/** The mobile/PWA metas DSH's own index does not carry. */
export function mobileMetaMarkup(): string {
  return `${MOBILE_META_MARKER}`
    + '<meta name="apple-mobile-web-app-capable" content="yes">'
    + '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">'
    + '<meta name="apple-mobile-web-app-title" content="DSH">'
    + '<meta name="theme-color" content="#1e1e2e">'
}

/**
 * The client-side socket watchdog, in one inline script.
 *
 * Behaviour, in order of aggressiveness:
 *
 * 1. every `WebSocket` the page creates is tracked, and one still CONNECTING
 *    after 8 s is closed so DSH's own retry loop advances instead of hanging;
 * 2. on `visibilitychange` → visible and on a bfcache `pageshow`, the page gets
 *    a 10 s grace period; if by then at least one socket exists and none is
 *    OPEN, the page is reloaded once;
 * 3. reloads are capped (3 in a row, counted in sessionStorage so a reload loop
 *    cannot bootstrap itself) and rate-limited with a doubling cooldown; one
 *    successful socket open clears the escalation.
 *
 * A page that never created a socket (the app failed to boot for some other
 * reason) is never reloaded.
 *
 * @returns one inline `<script>` element.
 */
export function socketWatchdogScript(): string {
  return `<script>${SOCKET_WATCHDOG_MARKER}(function(){try{`
    + 'var W=self.WebSocket;if(typeof W!=="function")return;'
    + `var flags=globalThis.${PATCHES_GLOBAL};`
    + 'if(flags&&flags.socketWatchdog===true)return;'
    + `globalThis.${PATCHES_GLOBAL}=Object.assign({},flags,{socketWatchdog:true});`
    + 'var CONNECT_TIMEOUT_MS=8000,STUCK_AFTER_MS=15000,RESUME_GRACE_MS=10000;'
    + 'var COOLDOWN_BASE_MS=20000,COOLDOWN_MAX_MS=300000,MAX_RELOADS=3;'
    + 'var sockets=[],firstSeenAt=0,lastOpenAt=0,hiddenAt=0,visibleSince=Date.now();'
    + 'var lastReloadAt=0,cooldown=COOLDOWN_BASE_MS;'
    + 'function readReloads(){try{return Number(self.sessionStorage.getItem("dshLanGuardReloads")||"0")||0}catch(e){return 0}}'
    + 'function writeReloads(n){try{self.sessionStorage.setItem("dshLanGuardReloads",String(n))}catch(e){}}'
    + 'var reloads=readReloads();'
    + 'function track(ws){'
    + 'sockets.push(ws);if(sockets.length>32)sockets.shift();'
    + 'if(firstSeenAt===0)firstSeenAt=Date.now();'
    + 'var timer=setTimeout(function(){try{if(ws.readyState===0)ws.close()}catch(e){}},CONNECT_TIMEOUT_MS);'
    + 'ws.addEventListener("open",function(){lastOpenAt=Date.now();reloads=0;writeReloads(0);cooldown=COOLDOWN_BASE_MS});'
    + 'ws.addEventListener("close",function(){clearTimeout(timer)});'
    + 'return ws}'
    + 'function Wrapped(url,protocols){var ws=protocols===undefined?new W(url):new W(url,protocols);return track(ws)}'
    + 'Wrapped.prototype=W.prototype;Wrapped.CONNECTING=0;Wrapped.OPEN=1;Wrapped.CLOSING=2;Wrapped.CLOSED=3;'
    + 'self.WebSocket=Wrapped;'
    + 'function openCount(){var n=0;for(var i=0;i<sockets.length;i++){if(sockets[i].readyState===1)n+=1}return n}'
    + 'function judge(reason){'
    + 'try{var doc=self.document;'
    + 'if(doc&&doc.visibilityState==="hidden")return;'
    + 'if(sockets.length===0)return;'
    + 'if(openCount()>0)return;'
    + 'var t=Date.now();'
    + 'if(t-visibleSince<RESUME_GRACE_MS)return;'
    + 'if(t-Math.max(lastOpenAt,firstSeenAt)<STUCK_AFTER_MS)return;'
    + 'if(lastReloadAt!==0&&t-lastReloadAt<cooldown)return;'
    + 'if(reloads>=MAX_RELOADS)return;'
    + 'reloads+=1;writeReloads(reloads);lastReloadAt=t;cooldown=Math.min(COOLDOWN_MAX_MS,cooldown*2);'
    + 'try{console.warn("[dsh-lan-guard] reloading: the session socket is not open ("+reason+")")}catch(e){}'
    + 'self.location.reload()}catch(e){}}'
    + 'setInterval(function(){judge("watchdog")},2000);'
    + 'var doc=self.document;'
    + 'if(doc&&typeof doc.addEventListener==="function"){'
    + 'doc.addEventListener("visibilitychange",function(){'
    + 'if(doc.visibilityState==="hidden"){hiddenAt=Date.now();return}'
    + 'if(hiddenAt!==0&&Date.now()-hiddenAt>1000){visibleSince=Date.now()}'
    + 'setTimeout(function(){judge("resume")},RESUME_GRACE_MS+500)})}'
    + 'if(typeof self.addEventListener==="function"){'
    + 'self.addEventListener("pageshow",function(event){'
    + 'if(event&&event.persisted){visibleSince=Date.now();setTimeout(function(){judge("bfcache")},RESUME_GRACE_MS+500)}})}'
    + '}catch(e){}})()</script>'
}

/**
 * Insert the unlock script into one index document.
 *
 * @param html - the index body as DSH rendered it.
 * @returns the body with the script inserted.
 */
export function injectSettingsUnlock(html: string): string {
  if (html.includes(UNLOCK_MARKER)) return html
  return insertAfterHead(html, settingsUnlockScript())
}

/**
 * Insert the mobile metas (and rewrite the viewport meta) plus the shims.
 *
 * The existing viewport meta is REPLACED rather than duplicated: with two
 * viewport metas the winner differs between engines, and `viewport-fit=cover`
 * (the notch) is the only part DSH's own tag lacks. Zoom stays enabled — this
 * plugin's mobile contract is about target sizes and horizontal scrolling, not
 * about taking the user's pinch gesture away.
 *
 * @param html - the index body as DSH rendered it.
 * @returns the body with the metas and shims inserted.
 */
export function injectMobileCompat(html: string): string {
  if (html.includes(MOBILE_COMPAT_MARKER)) return html
  return insertAfterHead(injectMobileMetas(html), mobileCompatScript())
}

/**
 * Insert the socket watchdog.
 *
 * @param html - the index body as DSH rendered it.
 * @returns the body with the watchdog inserted.
 */
export function injectSocketWatchdog(html: string): string {
  if (html.includes(SOCKET_WATCHDOG_MARKER)) return html
  return insertAfterHead(html, socketWatchdogScript())
}

/** Add the mobile metas and upgrade the viewport tag, idempotently. */
function injectMobileMetas(html: string): string {
  if (html.includes(MOBILE_META_MARKER)) return html
  const viewport = /<meta\s+name=["']viewport["'][^>]*>/i
  const replacement = '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">'
    + mobileMetaMarkup()
  if (viewport.test(html)) return html.replace(viewport, replacement)
  return insertAfterHead(html, replacement)
}

/** Insert markup immediately after the opening `<head>`, or prepend it. */
function insertAfterHead(html: string, markup: string): string {
  const open = /<head(?:\s[^>]*)?>/i.exec(html)
  if (open === null) return `${markup}${html}`
  const at = open.index + open[0].length
  return `${html.slice(0, at)}${markup}${html.slice(at)}`
}

/** Options for {@link registerIndexPatches}. */
export interface RegisterIndexPatchesOptions {
  /** DSH's web server service (or a stub). */
  webServer?: { tapIndex?: unknown } | undefined
  /** The live switches, read on every index render. */
  switches: IndexPatchSwitches
  /** Logger; a missing seam is a warning, not a failure. */
  logger?: LanGuardLogger
}

/**
 * Install the index tap, when the host exposes one.
 *
 * @param options - see {@link RegisterIndexPatchesOptions}.
 * @returns the disposer removing the tap, or `undefined` when unsupported.
 */
export function registerIndexPatches(options: RegisterIndexPatchesOptions): (() => void) | undefined {
  const logger = options.logger ?? noopLogger
  const tapIndex = options.webServer?.tapIndex
  if (typeof tapIndex !== 'function') {
    // An older or narrower host: degrade to today's behaviour (no LAN settings
    // unlock, no mobile shims) instead of failing the whole plugin.
    logger.warn('webServer.tapIndex is unavailable; the index patches were not installed')
    return undefined
  }
  const tap = tapIndex as (transform: (html: string) => string) => () => void
  return tap.call(options.webServer, (html: string) => {
    let out = html
    if (options.switches.mobileCompat()) out = injectMobileCompat(out)
    if (options.switches.mobileScrollFix()) out = injectMobileScrollFix(out)
    if (options.switches.mobileTurnRail()) out = injectMobileTurnRail(out)
    if (options.switches.socketWatchdog()) out = injectSocketWatchdog(out)
    if (options.switches.settingsUnlock()) out = injectSettingsUnlock(out)
    return out
  })
}
