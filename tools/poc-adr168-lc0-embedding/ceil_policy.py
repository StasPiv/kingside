import sys, numpy as np
sys.path.insert(0,"/tmp/ks4989-libs")
import torch, torch.nn as nn
torch.manual_seed(0); np.random.seed(0); torch.set_num_threads(8)
pol=torch.tensor(np.load("/tmp/ks4989/t_pol.npy")); N=pol.shape[0]
idx=np.random.permutation(N); ntr=int(N*0.9); tr,te=idx[:ntr],idx[ntr:]
pol_tr,pol_te=pol[tr],pol[te]; teach1=pol_te.argmax(1)
A=np.load("/tmp/ks4989/t_act_encoder9.npy").astype(np.float32)
mu=A[tr].mean(0); sd=A[tr].std(0)+1e-6; A=torch.tensor((A-mu)/sd); din=A.shape[1]
Atr,Ate=A[tr],A[te]
def kl(logp,tgt): return (tgt*(torch.log(tgt+1e-9)-torch.log_softmax(logp,1))).sum(1).mean()
# крупный расшифровщик из полной активации: реальный потолок доступности политики
net=nn.Sequential(nn.Linear(din,2048),nn.ReLU(),nn.Linear(2048,2048),nn.ReLU(),nn.Linear(2048,1858))
opt=torch.optim.Adam(net.parameters(),lr=1e-3,weight_decay=1e-5)
for e in range(30):
    perm=torch.randperm(ntr)
    for i in range(0,ntr,512):
        b=perm[i:i+512]; loss=kl(net(Atr[b]),pol_tr[b])
        opt.zero_grad(); loss.backward(); opt.step()
net.eval()
with torch.no_grad():
    pl=net(Ate); t1=(pl.argmax(1)==teach1).float().mean().item()
    p3=pl.topk(3,1).indices; g3=pol_te.topk(3,1).indices
    ov=np.mean([len(set(p3[i].tolist())&set(g3[i].tolist()))/3 for i in range(len(p3))])
    print(f"ceil-BIG-D(A) policy: top1={t1:.3f} top3ov={ov:.3f} KL={kl(pl,pol_te).item():.4f}")
