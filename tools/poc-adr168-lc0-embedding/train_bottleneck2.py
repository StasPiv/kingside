"""KS-4998 (disambiguation): слой encoder9.
Потолки без сжатия (сколько вытягивает сам расшифровщик из полной активации) +
узкое горло со СЛАБЫМ, но не линейным D (один скрытый слой). Разделяет
«инфо не в z» и «линейный D не выражает 1858-argmax».
"""
import sys, numpy as np
sys.path.insert(0, "/tmp/ks4989-libs")
import torch, torch.nn as nn
torch.manual_seed(0); np.random.seed(0); torch.set_num_threads(8)

pol = torch.tensor(np.load("/tmp/ks4989/t_pol.npy")); wdl = torch.tensor(np.load("/tmp/ks4989/t_wdl.npy"))
N = pol.shape[0]; idx = np.random.permutation(N); ntr=int(N*0.9); tr,te=idx[:ntr],idx[ntr:]
pol_tr,pol_te=pol[tr],pol[te]; wdl_tr,wdl_te=wdl[tr],wdl[te]
tgt_eval_te=(wdl_te[:,0]-wdl_te[:,2]); teach1=pol_te.argmax(1)
A=np.load("/tmp/ks4989/t_act_encoder9.npy").astype(np.float32)
mu=A[tr].mean(0); sd=A[tr].std(0)+1e-6; A=torch.tensor((A-mu)/sd); din=A.shape[1]
Atr,Ate=A[tr],A[te]
def kl(logp,tgt): return (tgt*(torch.log(tgt+1e-9)-torch.log_softmax(logp,1))).sum(1).mean()

def train(enc, dec, tag):
    opt=torch.optim.Adam(list(enc.parameters())+list(dec.parameters()),lr=1e-3,weight_decay=1e-5)
    for e in range(25):
        perm=torch.randperm(ntr)
        for i in range(0,ntr,512):
            b=perm[i:i+512]; z=enc(Atr[b]); pl,wl=dec(z)
            loss=kl(pl,pol_tr[b])+kl(wl,wdl_tr[b])
            opt.zero_grad(); loss.backward(); opt.step()
    enc.eval(); dec.eval()
    with torch.no_grad():
        pl,wl=dec(enc(Ate)); t1=(pl.argmax(1)==teach1).float().mean().item()
        p3=pl.topk(3,1).indices; g3=pol_te.topk(3,1).indices
        ov=np.mean([len(set(p3[i].tolist())&set(g3[i].tolist()))/3 for i in range(len(p3))])
        klv=kl(pl,pol_te).item(); wsm=torch.softmax(wl,1)
        wmae=((wsm[:,0]-wsm[:,2])-tgt_eval_te).abs().mean().item()
    print(f"  {tag}: top1={t1:.3f} top3ov={ov:.3f} KL={klv:.4f} WDL_MAE={wmae:.4f}",flush=True)

class Idn(nn.Module):
    def forward(s,x): return x
class Enc(nn.Module):
    def __init__(s,z): super().__init__(); s.n=nn.Sequential(nn.Linear(din,256),nn.ReLU(),nn.Linear(256,z))
    def forward(s,x): return s.n(x)
class Lin(nn.Module):
    def __init__(s,d): super().__init__(); s.p=nn.Linear(d,1858); s.w=nn.Linear(d,3)
    def forward(s,z): return s.p(z),s.w(z)
class Mlp(nn.Module):  # слабый, но нелинейный: один скрытый слой 256
    def __init__(s,d): super().__init__(); s.h=nn.Sequential(nn.Linear(d,256),nn.ReLU()); s.p=nn.Linear(256,1858); s.w=nn.Linear(256,3)
    def forward(s,z): h=s.h(z); return s.p(h),s.w(h)

print("=== ПОТОЛКИ без сжатия (вход = полная активация 16384) ===",flush=True)
train(Idn(), Lin(din), "ceil-Lin(A)")
train(Idn(), Mlp(din), "ceil-MLP(A)")
print("=== узкое горло, СЛАБЫЙ нелинейный D (z->256->out) ===",flush=True)
for z in [16,32,64]:
    train(Enc(z), Mlp(z), f"z={z:2d} MLP-D")
print("порог верности: top1>=0.90 & WDL_MAE<=0.05",flush=True)
