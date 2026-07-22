"""KS-5001: top-k SAE над encoder9 (штраф L1 убран, на токен оставляем k сильнейших).
k∈{16,32,64}. Таблица k→реконструкция+причинность, вердикт PASS/FAIL. Один заход, стоп.
Признаки не именуются."""
import sys, numpy as np
sys.path.insert(0, "/tmp/ks4989-libs")
import torch, torch.nn as nn, onnxruntime as ort
torch.manual_seed(0); np.random.seed(0); torch.set_num_threads(8)

DICT=2048; KS=[16,32,64]; EPOCHS=6; BS=4096
fens=[l for l in open("/tmp/ks4989/t_fens.txt").read().split("\n") if l]
act=np.load("/tmp/ks4989/t_act_encoder9.npy").astype(np.float32); Np=act.shape[0]
X=act.reshape(Np*64,256); pos_of=np.repeat(np.arange(Np),64)
Xt=torch.tensor(X); n=Xt.shape[0]; bdec0=Xt.mean(0)
rng=np.random.default_rng(0)
tr=torch.tensor(rng.choice(n,800000,replace=False)); ev=torch.tensor(rng.choice(n,200000,replace=False))
Xtr=Xt[tr]; Xev=Xt[ev]
print(f"tokens train={Xtr.shape[0]} eval={Xev.shape[0]} dict={DICT}",flush=True)

class TopK(nn.Module):
    def __init__(s,k):
        super().__init__(); s.k=k
        s.We=nn.Parameter(torch.randn(256,DICT)*0.01); s.be=nn.Parameter(torch.zeros(DICT))
        s.Wd=nn.Parameter(torch.randn(DICT,256)*0.01); s.bd=nn.Parameter(bdec0.clone())
    def enc(s,x):
        f=torch.relu((x-s.bd)@s.We+s.be)
        v,i=f.topk(s.k,dim=1); m=torch.zeros_like(f); m.scatter_(1,i,v); return m
    def dec(s,f): return f@s.Wd+s.bd
    def nd(s):
        with torch.no_grad(): s.Wd.data=s.Wd.data/(s.Wd.data.norm(dim=1,keepdim=True)+1e-8)

def train(k):
    sae=TopK(k); sae.nd(); opt=torch.optim.Adam(sae.parameters(),lr=1e-3); m=Xtr.shape[0]
    for e in range(EPOCHS):
        perm=torch.randperm(m)
        for i in range(0,m,BS):
            x=Xtr[perm[i:i+BS]]; xh=sae.dec(sae.enc(x))
            loss=((x-xh)**2).sum(1).mean()
            opt.zero_grad(); loss.backward(); opt.step(); sae.nd()
    sae.eval()
    with torch.no_grad():
        rn=0.0; vd=0.0
        for i in range(0,Xev.shape[0],65536):
            x=Xev[i:i+65536]; xh=sae.dec(sae.enc(x))
            rn+=((x-xh)**2).sum().item(); vd+=((x-bdec0)**2).sum().item()
    return sae, 1-rn/vd

heads=ort.InferenceSession("/tmp/t1-heads.onnx",providers=["CPUExecutionProvider"])
def rh(a):
    o=heads.run(["/output/policy","/output/wdl"],{"/encoder9/ln2":a.astype(np.float32)})
    p=o[0].ravel(); p=np.exp(p-p.max()); p/=p.sum(); w=o[1].ravel(); w=np.exp(w-w.max()); w/=w.sum()
    return p,(w[0]-w[2])

def causal(sae,tag):
    We=sae.We.detach().numpy(); be=sae.be.detach().numpy(); Wd=sae.Wd.detach().numpy(); bd=sae.bd.detach().numpy()
    # яркость по среднему top-k активации
    act_sum=np.zeros(DICT);
    with torch.no_grad():
        for i in range(0,n,65536): act_sum+=sae.enc(Xt[i:i+65536]).numpy().sum(0)
    bright=np.argsort(-act_sum); sel=bright[:20]
    pos_max=np.full((Np,20),-1.0,np.float32)
    with torch.no_grad():
        for i in range(0,n,65536):
            f=sae.enc(Xt[i:i+65536]).numpy()[:,sel]; idx=pos_of[i:i+f.shape[0]]
            for c in range(20): np.maximum.at(pos_max[:,c],idx,f[:,c])
    passes=0; rows=[]
    for rank,k in enumerate([int(x) for x in bright[:5]]):
        cand=np.argsort(-pos_max[:,rank])[:150]; de=[];der=[];dp=[];dpr=[];t1=[]
        for p in cand:
            a=X[p*64:(p+1)*64].copy()
            fpre=np.maximum((a-bd)@We+be,0.0)
            # значение выбранного признака только там, где он в top-k токена
            kth=np.sort(fpre,1)[:,-sae.k][:,None]; fk=np.where(fpre[:,k:k+1]>=kth, fpre[:,k:k+1],0.0).ravel()
            a_abl=a-np.outer(fk,Wd[k]); rd=rng.normal(size=256); rd/=np.linalg.norm(rd)
            a_rnd=a-np.outer(fk,rd*np.linalg.norm(Wd[k]))
            p0,e0=rh(a); p1,e1=rh(a_abl); pr,er=rh(a_rnd)
            de.append(abs(e0-e1)); der.append(abs(e0-er)); t1.append(p0.argmax()!=p1.argmax())
            dp.append(float((p0*(np.log(p0+1e-9)-np.log(p1+1e-9))).sum())); dpr.append(float((p0*(np.log(p0+1e-9)-np.log(pr+1e-9))).sum()))
        mk=(np.mean(de)>=2*np.mean(der)) or (np.mean(dp)>=2*np.mean(dpr)); passes+=mk
        print(f"    #{k}: KL_pol {np.mean(dp):.4f}(rnd {np.mean(dpr):.4f}) |Δeval| {np.mean(de):.4f}(rnd {np.mean(der):.4f}) top1 {np.mean(t1):.3f} {'>rnd' if mk else '=rnd'}",flush=True)
    return passes, bright[:20], pos_max

print("=== top-k SAE ===",flush=True)
res=[]
for k in KS:
    sae,ve=train(k); res.append((k,ve,sae)); print(f"  k={k}: объясн.дисперсия={ve:.3f}",flush=True)
# лучший k по реконструкции (все L0=k по построению)
best=max(res,key=lambda r:r[1]); kb,veb,saeb=best
print(f"[выбор] лучший k={kb} объясн.дисперсия={veb:.3f}",flush=True)
print(f"[причинность] k={kb}:",flush=True)
passes,top20,pos_max=causal(saeb,f"k{kb}")
with open("/tmp/ks4989/sae_topk_top.txt","w") as fh:
    fh.write(f"top-k SAE encoder9 dict={DICT} k={kb} объясн.дисперсия={veb:.3f}; топ-20 признаков × топ-30 позиций\n")
    for rank,kk in enumerate([int(x) for x in top20]):
        col=pos_max[:,rank]; tp=np.argsort(-col)[:30]
        fh.write(f"\n# признак #{kk} (ранг {rank})\n")
        for p in tp: fh.write(f"  act={col[p]:.3f}  {fens[p]}\n")
print("[top] /tmp/ks4989/sae_topk_top.txt",flush=True)
verdict="PASS" if (veb>=0.5 and passes>=2) else "FAIL"
print(f"\nВЕРДИКТ: {verdict}  (лучшая реконструкция {veb:.3f} при k={kb}; признаков-причин>случайного {passes}/5)",flush=True)
print("СТОП.",flush=True)
