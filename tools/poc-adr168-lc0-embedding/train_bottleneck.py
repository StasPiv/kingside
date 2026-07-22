"""KS-4998: E(A)->z->слабый(линейный) D->(policy,WDL). Кривая верность↔размер z.
Порог (задан ДО прогона): верно если top-1>=0.90 и |ΔWDL(win-loss)|<=0.05; компактно если z<=32.
"""
import sys, numpy as np
sys.path.insert(0, "/tmp/ks4989-libs")
import torch, torch.nn as nn
torch.manual_seed(0); np.random.seed(0)
torch.set_num_threads(8)

ZDIMS = [8, 16, 32, 64]
LAYERS = ["encoder6", "encoder9"]
DEV = "cpu"

pol = torch.tensor(np.load("/tmp/ks4989/t_pol.npy"))          # [N,1858]
wdl = torch.tensor(np.load("/tmp/ks4989/t_wdl.npy"))          # [N,3]
N = pol.shape[0]; idx = np.random.permutation(N)
ntr = int(N*0.9); tr, te = idx[:ntr], idx[ntr:]
pol_tr, pol_te = pol[tr], pol[te]; wdl_tr, wdl_te = wdl[tr], wdl[te]
tgt_eval_te = (wdl_te[:,0]-wdl_te[:,2])
teach_top1 = pol_te.argmax(1)

class Enc(nn.Module):
    def __init__(s, din, z):
        super().__init__(); s.net = nn.Sequential(nn.Linear(din,256), nn.ReLU(), nn.Linear(256, z))
    def forward(s,x): return s.net(x)
class Dec(nn.Module):  # СЛАБЫЙ: линейный z->policy, z->wdl
    def __init__(s, z):
        super().__init__(); s.p = nn.Linear(z,1858); s.w = nn.Linear(z,3)
    def forward(s,zz): return s.p(zz), s.w(zz)

def kl(logp, tgt): return (tgt*(torch.log(tgt+1e-9) - torch.log_softmax(logp,1))).sum(1).mean()

def run(layer):
    A = np.load(f"/tmp/ks4989/t_act_{layer}.npy").astype(np.float32)   # [N,16384]
    mu = A[tr].mean(0); sd = A[tr].std(0)+1e-6
    A = torch.tensor((A-mu)/sd); din = A.shape[1]
    Atr, Ate = A[tr], A[te]
    out = []
    for z in ZDIMS:
        E = Enc(din,z).to(DEV); D = Dec(z).to(DEV)
        opt = torch.optim.Adam(list(E.parameters())+list(D.parameters()), lr=1e-3, weight_decay=1e-5)
        bs = 512; ep = 25
        for e in range(ep):
            perm = torch.randperm(ntr)
            for i in range(0, ntr, bs):
                b = perm[i:i+bs]
                zz = E(Atr[b]); pl, wl = D(zz)
                loss = kl(pl, pol_tr[b]) + kl(wl, wdl_tr[b])
                opt.zero_grad(); loss.backward(); opt.step()
        E.eval(); D.eval()
        with torch.no_grad():
            pl, wl = D(E(Ate))
            pred_top1 = pl.argmax(1)
            t1 = (pred_top1 == teach_top1).float().mean().item()
            # top-3 overlap
            p3 = pl.topk(3,1).indices; g3 = pol_te.topk(3,1).indices
            ov = np.mean([len(set(p3[i].tolist()) & set(g3[i].tolist()))/3 for i in range(len(p3))])
            klv = kl(pl, pol_te).item()
            wsm = torch.softmax(wl,1); ev = (wsm[:,0]-wsm[:,2])
            wmae = (ev - tgt_eval_te).abs().mean().item()
        ok = "OK" if (t1>=0.90 and wmae<=0.05) else ""
        print(f"  z={z:3d}: top1={t1:.3f}  top3ov={ov:.3f}  KL={klv:.4f}  WDL_MAE={wmae:.4f}  {ok}", flush=True)
        out.append((z,t1,ov,klv,wmae))
    return out

for L in LAYERS:
    print(f"=== LAYER {L} (din=16384 -> z; D линейный) ===", flush=True)
    run(L)
print("порог: верно top1>=0.90 & WDL_MAE<=0.05; компактно z<=32", flush=True)
