"""KS-4999: ОДИН SAE над активациями Lc0 encoder9 (по-токенно, 256-мерный остаточный
поток). Здоровье + топ-позиции признаков + причинность. Один прогон, затем стоп.
Признаки НЕ называются (толкование — architect)."""
import sys, numpy as np
sys.path.insert(0, "/tmp/ks4989-libs")
import torch, torch.nn as nn, onnxruntime as ort
torch.manual_seed(0); np.random.seed(0); torch.set_num_threads(8)

DICT = 2048          # одна конфигурация: 8x расширение над 256
L1 = 1e-3            # один коэффициент разреженности, без перебора
EPOCHS = 8; BS = 4096

fens = [l for l in open("/tmp/ks4989/t_fens.txt").read().split("\n") if l]
act = np.load("/tmp/ks4989/t_act_encoder9.npy").astype(np.float32)   # [N,16384]
Np = act.shape[0]
X = act.reshape(Np*64, 256)                                          # токены
pos_of = np.repeat(np.arange(Np), 64)                                # позиция каждого токена
Xt = torch.tensor(X)
bdec0 = Xt.mean(0)
print(f"tokens={Xt.shape[0]} dim=256 dict={DICT} l1={L1}", flush=True)

class SAE(nn.Module):
    def __init__(s):
        super().__init__()
        s.We = nn.Parameter(torch.randn(256, DICT)*0.01)
        s.be = nn.Parameter(torch.zeros(DICT))
        s.Wd = nn.Parameter(torch.randn(DICT, 256)*0.01)
        s.bd = nn.Parameter(bdec0.clone())
    def encode(s, x): return torch.relu((x - s.bd) @ s.We + s.be)
    def decode(s, f): return f @ s.Wd + s.bd
    def norm_dec(s):
        with torch.no_grad(): s.Wd.data = s.Wd.data / (s.Wd.data.norm(dim=1, keepdim=True) + 1e-8)

sae = SAE(); sae.norm_dec()
opt = torch.optim.Adam(sae.parameters(), lr=1e-3)
n = Xt.shape[0]
for e in range(EPOCHS):
    perm = torch.randperm(n)
    tot=0; cnt=0
    for i in range(0, n, BS):
        b = perm[i:i+BS]; x = Xt[b]
        f = sae.encode(x); xh = sae.decode(f)
        mse = ((x-xh)**2).sum(1).mean()
        loss = mse + L1*f.abs().sum(1).mean()
        opt.zero_grad(); loss.backward(); opt.step(); sae.norm_dec()
        tot+=mse.item(); cnt+=1
    print(f"  epoch {e}: recon MSE(sum) {tot/cnt:.3f}", flush=True)

# ---- здоровье (потоково, без хранения полной матрицы признаков) ----
sae.eval()
torch.save(sae.state_dict(), "/tmp/ks4989/sae_encoder9.pt")
with torch.no_grad():
    recon_num=0.0; var_den=0.0; l0=0.0; nt=0
    act_sum = np.zeros(DICT, np.float64); act_cnt = np.zeros(DICT, np.float64)
    for i in range(0, n, 65536):
        x = Xt[i:i+65536]; f = sae.encode(x); xh = sae.decode(f)
        recon_num += ((x-xh)**2).sum().item(); var_den += ((x-bdec0)**2).sum().item()
        l0 += (f>0).float().sum().item(); nt += x.shape[0]
        fn = f.numpy(); act_sum += fn.sum(0); act_cnt += (fn>0).sum(0)
frac_unexpl = recon_num/var_den
mean_act = act_sum/nt; freq = act_cnt/nt; dead = int((freq==0).sum())
print(f"[health] variance explained = {1-frac_unexpl:.3f}  (норм. MSE {frac_unexpl:.3f})", flush=True)
print(f"[health] L0 (акт. признаков/токен) = {l0/nt:.1f} из {DICT}", flush=True)
print(f"[health] мёртвых признаков: {dead}/{DICT}; медианная частота живого: {np.median(freq[freq>0]):.4f}", flush=True)

# ---- яркость и топ-позиции (пасс 2: только выбранные признаки) ----
bright = np.argsort(-mean_act)
top20 = [int(k) for k in bright[:20]]
sel = np.array(top20)
pos_max = np.full((Np, len(sel)), -1.0, np.float32)
with torch.no_grad():
    for i in range(0, n, 65536):
        f = sae.encode(Xt[i:i+65536]).numpy()[:, sel]
        idx = pos_of[i:i+f.shape[0]]
        for c in range(len(sel)):
            np.maximum.at(pos_max[:, c], idx, f[:, c])
with open("/tmp/ks4989/sae_top_features.txt","w") as fh:
    fh.write(f"SAE encoder9 dict={DICT} l1={L1}; топ-20 признаков (без наименования), топ-30 позиций каждый\n")
    for rank,k in enumerate(top20):
        col = pos_max[:, rank]; top_pos = np.argsort(-col)[:30]
        fh.write(f"\n# признак #{k} (ранг {rank}, mean_act {mean_act[k]:.3f}, freq {freq[k]:.4f})\n")
        for p in top_pos:
            fh.write(f"  act={col[p]:.3f}  {fens[p]}\n")
print("[top] записано /tmp/ks4989/sae_top_features.txt (топ-20 × топ-30 позиций)", flush=True)

# ---- причинность (топ-5 ярких): удалить признак, замерить сдвиг решения Lc0 ----
heads = ort.InferenceSession("/tmp/t1-heads.onnx", providers=["CPUExecutionProvider"])
Wd = sae.Wd.detach().numpy(); We = sae.We.detach().numpy(); be = sae.be.detach().numpy(); bd = sae.bd.detach().numpy()
def run_heads(act64):  # [64,256] -> (policy softmax, wdl eval)
    o = heads.run(["/output/policy","/output/wdl"], {"/encoder9/ln2": act64.astype(np.float32)})
    p = o[0].ravel(); p = np.exp(p-p.max()); p/=p.sum()
    w = o[1].ravel(); w = np.exp(w-w.max()); w/=w.sum()
    return p, (w[0]-w[2])
print("[causal] удаление признака (топ-5 ярких) vs случайное направление той же нормы:", flush=True)
rng = np.random.default_rng(0)
for rank,k in enumerate([int(x) for x in bright[:5]]):
    cand = np.argsort(-pos_max[:, rank])[:150]   # позиции, где признак активен (pos_max колонка rank)
    dpol=[]; dev=[]; t1=[]; dpol_r=[]; dev_r=[]
    for p in cand:
        a = X[p*64:(p+1)*64].copy()                       # [64,256] оригинал
        f = np.maximum((a-bd)@We+be,0.0)[:,k]             # активация признака по токенам
        a_abl = a - np.outer(f, Wd[k])                    # убрать вклад признака
        rdir = rng.normal(size=256); rdir/=np.linalg.norm(rdir)
        a_rnd = a - np.outer(f, rdir*np.linalg.norm(Wd[k]))
        p0,e0 = run_heads(a); p1,e1 = run_heads(a_abl); pr,er = run_heads(a_rnd)
        dpol.append(float((p0*(np.log(p0+1e-9)-np.log(p1+1e-9))).sum())); dev.append(abs(e0-e1)); t1.append(p0.argmax()!=p1.argmax())
        dpol_r.append(float((p0*(np.log(p0+1e-9)-np.log(pr+1e-9))).sum())); dev_r.append(abs(e0-er))
    print(f"  #{k}: KL_pol {np.mean(dpol):.4f} (rnd {np.mean(dpol_r):.4f}) | |Δeval| {np.mean(dev):.4f} (rnd {np.mean(dev_r):.4f}) | top1-смена {np.mean(t1):.3f}", flush=True)
print("DONE. СТОП.", flush=True)
