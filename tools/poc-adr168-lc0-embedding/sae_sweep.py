"""KS-5000: ОДИН заход — перебор силы разреженности SAE над encoder9.
l1 ∈ {1e-2,3e-2,1e-1,3e-1}. Здоровье (объяснённая дисперсия + L0) по каждому,
выбор здорового разреженного, топ-позиции + причинность на нём, вердикт PASS/FAIL.
Жёсткий стоп. Признаки не именуются."""
import sys, numpy as np
sys.path.insert(0, "/tmp/ks4989-libs")
import torch, torch.nn as nn, onnxruntime as ort
torch.manual_seed(0); np.random.seed(0); torch.set_num_threads(8)

DICT=2048; L1S=[1e-2,3e-2,1e-1,3e-1]; EPOCHS=6; BS=4096
fens=[l for l in open("/tmp/ks4989/t_fens.txt").read().split("\n") if l]
act=np.load("/tmp/ks4989/t_act_encoder9.npy").astype(np.float32); Np=act.shape[0]
X=act.reshape(Np*64,256); pos_of=np.repeat(np.arange(Np),64)
Xt=torch.tensor(X); n=Xt.shape[0]; bdec0=Xt.mean(0)
rng=np.random.default_rng(0)
tr_idx=torch.tensor(rng.choice(n,800000,replace=False))
ev_idx=torch.tensor(rng.choice(n,200000,replace=False))
Xtr=Xt[tr_idx]; Xev=Xt[ev_idx]
print(f"tokens train={Xtr.shape[0]} eval={Xev.shape[0]} dict={DICT}",flush=True)

class SAE(nn.Module):
    def __init__(s):
        super().__init__()
        s.We=nn.Parameter(torch.randn(256,DICT)*0.01); s.be=nn.Parameter(torch.zeros(DICT))
        s.Wd=nn.Parameter(torch.randn(DICT,256)*0.01); s.bd=nn.Parameter(bdec0.clone())
    def encode(s,x): return torch.relu((x-s.bd)@s.We+s.be)
    def decode(s,f): return f@s.Wd+s.bd
    def norm_dec(s):
        with torch.no_grad(): s.Wd.data=s.Wd.data/(s.Wd.data.norm(dim=1,keepdim=True)+1e-8)

def train(l1):
    sae=SAE(); sae.norm_dec(); opt=torch.optim.Adam(sae.parameters(),lr=1e-3)
    m=Xtr.shape[0]
    for e in range(EPOCHS):
        perm=torch.randperm(m)
        for i in range(0,m,BS):
            x=Xtr[perm[i:i+BS]]; f=sae.encode(x); xh=sae.decode(f)
            loss=((x-xh)**2).sum(1).mean()+l1*f.abs().sum(1).mean()
            opt.zero_grad(); loss.backward(); opt.step(); sae.norm_dec()
    sae.eval()
    with torch.no_grad():
        rn=0.0; vd=0.0; l0=0.0; nt=0
        for i in range(0,Xev.shape[0],65536):
            x=Xev[i:i+65536]; f=sae.encode(x); xh=sae.decode(f)
            rn+=((x-xh)**2).sum().item(); vd+=((x-bdec0)**2).sum().item()
            l0+=(f>0).float().sum().item(); nt+=x.shape[0]
    return sae, 1-rn/vd, l0/nt

print("=== перебор разреженности ===",flush=True)
res=[]
for l1 in L1S:
    sae,ve,l0=train(l1); res.append((l1,ve,l0,sae))
    print(f"  l1={l1:.0e}: объясн.дисперсия={ve:.3f}  L0={l0:.1f}/{DICT}",flush=True)

# выбор здорового разреженного: L0 в [8,80], максимальная дисперсия
healthy=[r for r in res if 8<=r[2]<=80 and r[1]>=0.5]
chosen = max(healthy,key=lambda r:r[1]) if healthy else min(res,key=lambda r:abs(r[2]-40))
l1c,vec_,l0c,sae=chosen
print(f"[выбор] l1={l1c:.0e} объясн.дисперсия={vec_:.3f} L0={l0c:.1f}  здоровый_разреженный={bool(healthy)}",flush=True)

# топ-признаки (пасс по всем токенам) + топ-30 позиций
with torch.no_grad():
    act_sum=np.zeros(DICT); nt=0
    for i in range(0,n,65536):
        f=sae.encode(Xt[i:i+65536]).numpy(); act_sum+=f.sum(0); nt+=f.shape[0]
mean_act=act_sum/nt; bright=np.argsort(-mean_act); top20=[int(k) for k in bright[:20]]; sel=np.array(top20)
pos_max=np.full((Np,len(sel)),-1.0,np.float32)
with torch.no_grad():
    for i in range(0,n,65536):
        f=sae.encode(Xt[i:i+65536]).numpy()[:,sel]; idx=pos_of[i:i+f.shape[0]]
        for c in range(len(sel)): np.maximum.at(pos_max[:,c],idx,f[:,c])
with open("/tmp/ks4989/sae_sweep_top.txt","w") as fh:
    fh.write(f"SAE encoder9 dict={DICT} l1={l1c:.0e} L0={l0c:.1f}; топ-20 признаков × топ-30 позиций (без наименования)\n")
    for rank,k in enumerate(top20):
        col=pos_max[:,rank]; tp=np.argsort(-col)[:30]
        fh.write(f"\n# признак #{k} (ранг {rank}, mean_act {mean_act[k]:.3f})\n")
        for p in tp: fh.write(f"  act={col[p]:.3f}  {fens[p]}\n")
print("[top] /tmp/ks4989/sae_sweep_top.txt",flush=True)

# причинность топ-5
heads=ort.InferenceSession("/tmp/t1-heads.onnx",providers=["CPUExecutionProvider"])
We=sae.We.detach().numpy(); be=sae.be.detach().numpy(); Wd=sae.Wd.detach().numpy(); bd=sae.bd.detach().numpy()
def rh(a):
    o=heads.run(["/output/policy","/output/wdl"],{"/encoder9/ln2":a.astype(np.float32)})
    p=o[0].ravel(); p=np.exp(p-p.max()); p/=p.sum(); w=o[1].ravel(); w=np.exp(w-w.max()); w/=w.sum()
    return p,(w[0]-w[2])
print("[причинность] удаление признака vs случайное направление той же нормы:",flush=True)
passes=0
for rank,k in enumerate([int(x) for x in bright[:5]]):
    cand=np.argsort(-pos_max[:,rank])[:150]
    dp=[];de=[];t1=[];dpr=[];der=[]
    for p in cand:
        a=X[p*64:(p+1)*64].copy(); f=np.maximum((a-bd)@We+be,0.0)[:,k]
        a_abl=a-np.outer(f,Wd[k]); rd=rng.normal(size=256); rd/=np.linalg.norm(rd)
        a_rnd=a-np.outer(f,rd*np.linalg.norm(Wd[k]))
        p0,e0=rh(a); p1,e1=rh(a_abl); pr,er=rh(a_rnd)
        dp.append(float((p0*(np.log(p0+1e-9)-np.log(p1+1e-9))).sum())); de.append(abs(e0-e1)); t1.append(p0.argmax()!=p1.argmax())
        dpr.append(float((p0*(np.log(p0+1e-9)-np.log(pr+1e-9))).sum())); der.append(abs(e0-er))
    mk=(np.mean(de)>=2*np.mean(der)) or (np.mean(dp)>=2*np.mean(dpr)); passes+=mk
    print(f"  #{k}: KL_pol {np.mean(dp):.4f}(rnd {np.mean(dpr):.4f}) |Δeval| {np.mean(de):.4f}(rnd {np.mean(der):.4f}) top1 {np.mean(t1):.3f} {'>rnd' if mk else '=rnd'}",flush=True)

verdict = "PASS" if (healthy and passes>=2) else "FAIL"
print(f"\nВЕРДИКТ: {verdict}  (здоровый_разреженный={bool(healthy)}, признаков-причин>случайного: {passes}/5)",flush=True)
print("СТОП.",flush=True)
