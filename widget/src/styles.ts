// Injected into the closed shadow root. Shadow scoping stops our styles leaking out; the
// rules below stop host styles leaking in:
//  * Outer-page rules beat :host rules for the host element itself (e.g. a page-level
//    `* { font-family: X !important }`), and children would inherit them. For !important
//    declarations the shadow context wins, so `all: initial !important` neutralises that.
//  * Font/colour are then set on our own top-level elements, never inherited from the page.
export const css = `
:host{all:initial!important}
:host{--ac:#4f46e5;--acf:#fff;--bg:#fff;--fg:#111827;--mu:#6b7280;--bd:#e5e7eb;--sf:#f9fafb;--er:#b91c1c;--ok:#047857;--sh:0 12px 40px rgba(0,0,0,.18)}
.fab,.panel{z-index:2147483646;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);letter-spacing:normal;word-spacing:normal;text-align:left;text-transform:none;white-space:normal;direction:ltr;visibility:visible;cursor:auto}
@media (prefers-color-scheme:dark){:host(:not([data-theme=light])){--bg:#18181b;--fg:#f4f4f5;--mu:#a1a1aa;--bd:#3f3f46;--sf:#27272a;--er:#f87171;--ok:#34d399}}
:host([data-theme=dark]){--bg:#18181b;--fg:#f4f4f5;--mu:#a1a1aa;--bd:#3f3f46;--sf:#27272a;--er:#f87171;--ok:#34d399}
*{box-sizing:border-box;margin:0;font:inherit;color:inherit}
button{cursor:pointer;border:0;background:none;padding:0}
button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--ac);outline-offset:1px}
.fab{position:fixed;width:52px;height:52px;border-radius:50%;background:var(--ac);color:var(--acf);box-shadow:var(--sh);display:grid;place-items:center;touch-action:none;user-select:none;-webkit-user-select:none;transition:transform .15s}
.fab:active{transform:scale(.94)}
.fab svg{width:24px;height:24px}
.badge{position:absolute;top:-2px;right:-2px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#dc2626;color:#fff;font-size:11px;font-weight:700;display:grid;place-items:center}
.panel{position:fixed;right:16px;bottom:80px;width:380px;max-width:calc(100vw - 32px);height:min(600px,calc(100vh - 100px));background:var(--bg);border:1px solid var(--bd);border-radius:14px;box-shadow:var(--sh);display:flex;flex-direction:column;overflow:hidden}
@media (max-width:480px){.panel{inset:0;width:100%;max-width:none;height:100%;border-radius:0;border:0}}
.hd{display:flex;align-items:center;gap:4px;padding:10px 12px;border-bottom:1px solid var(--bd)}
.tab{padding:6px 10px;border-radius:8px;color:var(--mu);font-weight:500}
.tab[aria-selected=true]{background:var(--sf);color:var(--fg)}
.x{margin-left:auto;width:32px;height:32px;border-radius:8px;color:var(--mu);font-size:20px}
.x:hover,.tab:hover{background:var(--sf)}
.bd{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
.bd.drag{outline:2px dashed var(--ac);outline-offset:-6px}
label{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:600;color:var(--mu)}
input,textarea,select{width:100%;padding:8px 10px;border:1px solid var(--bd);border-radius:8px;background:var(--bg);color:var(--fg);font-size:14px;font-weight:400}
textarea{resize:vertical;min-height:84px}
.row{display:flex;gap:8px}.row>*{flex:1}
.hint{font-size:12px;color:var(--mu)}
.err{font-size:13px;color:var(--er)}
.atts{display:flex;flex-wrap:wrap;gap:6px}
.att{position:relative;width:64px;height:64px;border:1px solid var(--bd);border-radius:8px;overflow:hidden;background:var(--sf);display:grid;place-items:center;font-size:10px;text-align:center;padding:2px;word-break:break-all;color:var(--mu)}
.att img{width:100%;height:100%;object-fit:cover}
.att button{position:absolute;top:2px;right:2px;width:18px;height:18px;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;font-size:12px;line-height:18px}
.btn{padding:9px 14px;border-radius:8px;background:var(--ac);color:var(--acf);font-weight:600}
.btn:disabled{opacity:.55;cursor:default}
.ghost{padding:8px 10px;border-radius:8px;border:1px solid var(--bd);color:var(--fg)}
.ft{display:flex;gap:8px;align-items:center;padding:10px 12px;border-top:1px solid var(--bd)}
.ft .btn{margin-left:auto}
.ok{text-align:center;padding:32px 8px;display:flex;flex-direction:column;gap:10px;align-items:center}
.ok b{font-size:18px;color:var(--ok)}
.li{display:flex;flex-direction:column;gap:2px;text-align:left;padding:10px;border:1px solid var(--bd);border-radius:10px}
.li:hover{background:var(--sf)}
.li small{color:var(--mu);font-size:12px}
.li .top{display:flex;justify-content:space-between;gap:8px;align-items:center}
.st{font-size:11px;font-weight:600;padding:2px 8px;border-radius:99px;background:var(--sf);border:1px solid var(--bd);white-space:nowrap}
.st.resolved,.st.closed{color:var(--ok)}
.st.in_progress{color:#b45309}
.msg{max-width:85%;padding:8px 11px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}
.msg small{display:block;font-size:11px;color:var(--mu);margin-top:3px}
.msg.client{align-self:flex-end;background:var(--ac);color:var(--acf)}
.msg.client small{color:inherit;opacity:.75}
.msg.developer{align-self:flex-start;background:var(--sf);border:1px solid var(--bd)}
.msg.system{align-self:center;font-size:12px;color:var(--mu);text-align:center;max-width:100%}
.ft textarea{min-height:40px;height:40px;flex:1}
.back{color:var(--mu);font-size:13px;align-self:flex-start}
.empty{color:var(--mu);text-align:center;padding:40px 0}
`;
