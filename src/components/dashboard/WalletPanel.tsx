import { useCallback, useEffect, useState } from "react";
import { ALLOWED_ADDRESS_PREFIXES, EXPLORER, NET_FEE, NETWORK_LABEL, RESERVE } from "../../constants";
import { fmt, isKaspaAddress, shortAddr } from "../../helpers";
import { kasBalance, kasUtxos } from "../../api/kaspaApi";
import { C, mono } from "../../tokens";
import { WalletAdapter } from "../../wallet/WalletAdapter";
import { SigningModal } from "../SigningModal";
import { Badge, Btn, Card, ExtLink, Inp, Label } from "../ui";

export function WalletPanel({agent, wallet, kasData}: any) {
  const [liveKas, setLiveKas] = useState(null as any);
  const [utxos, setUtxos] = useState([] as any[]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null as any);
  const [fetched, setFetched] = useState(null as any);
  const [signingTx, setSigningTx] = useState(null as any);
  const [withdrawTo, setWithdrawTo] = useState("");
  const [withdrawAmt, setWithdrawAmt] = useState("");
  const [note, setNote] = useState("");
  const [lastRefresh, setLastRefresh] = useState<number>(Date.now());

  const priceUsd = Number(kasData?.priceUsd || 0);
  const priceChange24h = Number(kasData?.change24h || 0);
  
  const refresh = useCallback(async()=>{
    setLoading(true); setErr(null);
    try{
      let b;
      if(wallet?.provider==="kasware"){b = await WalletAdapter.getKaswareBalance();}
      else{const r = await kasBalance(wallet?.address||agent.wallet); b = r.kas;}
      const u = await kasUtxos(wallet?.address||agent.wallet);
      setLiveKas(b);
      setUtxos(Array.isArray(u)?u.slice(0,10):[]);
      setFetched(new Date());
      setLastRefresh(Date.now());
    }catch(e: any){setErr(e.message);}
    setLoading(false);
  },[wallet,agent]);

  useEffect(()=>{refresh();},[refresh]);
  useEffect(() => {
    const interval = setInterval(() => refresh(), 30000);
    return () => clearInterval(interval);
  }, [refresh]);

  const bal = parseFloat(liveKas ?? agent.capitalLimit ?? 0);
  const maxSendKas = Math.max(0, bal - RESERVE - NET_FEE);
  const maxSend = maxSendKas.toFixed(4);
  const balanceUsd = priceUsd > 0 ? (bal * priceUsd) : null;
  const spendableKas = Math.max(0, bal - RESERVE - NET_FEE);
  const spendableUsd = priceUsd > 0 ? (spendableKas * priceUsd) : null;
  
  const initiateWithdraw = () => {
    const requested = Number(withdrawAmt);
    if(!isKaspaAddress(withdrawTo, ALLOWED_ADDRESS_PREFIXES) || !(requested > 0) || requested > maxSendKas) return;
    setSigningTx({ type:"WITHDRAW", from:wallet?.address, to:withdrawTo, amount_kas:Number(requested.toFixed(6)), purpose:note || "Withdrawal" });
  };
  const handleSigned = () => {setSigningTx(null); setWithdrawTo(""); setWithdrawAmt(""); setNote("");};

  const fmtUsd = (v: number | null) => v === null ? "—" : v >= 1 ? `$${v.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}` : `$${v.toFixed(4)}`;

  return (
    <div>
      {signingTx && <SigningModal tx={signingTx} wallet={wallet} onSign={handleSigned} onReject={()=>setSigningTx(null)}/>}
      
      {/* UNIFIED WALLET CARD */}
      <Card p={12} style={{marginBottom:12, background:`linear-gradient(135deg, ${C.s2} 0%, ${C.s1} 100%)`, border:`1px solid ${C.accent}30`, overflow:"hidden"}}>
        <div style={{height:3, background:`linear-gradient(90deg, ${C.accent}, ${C.purple})`}} />
        
        <div style={{padding:12}}>
          {/* Header with LIVE indicator */}
          <div style={{display:"flex", justifyContent:"flex-end", alignItems:"center", marginBottom:8}}>
            <div style={{display:"flex", alignItems:"center", gap:4, background:C.accent + "20", padding:"4px 8px", borderRadius:4}}>
              <span style={{width:6, height:6, borderRadius:"50%", background:C.accent, boxShadow:`0 0 6px ${C.accent}`}} />
              <span style={{fontSize:9, color:C.accent, fontWeight:600, ...mono}}>LIVE</span>
            </div>
          </div>
          
          {/* Balance */}
          <div style={{marginBottom:12}}>
            <div style={{fontSize:10, color:C.dim, ...mono, marginBottom:2}}>TOTAL BALANCE</div>
            <div style={{display:"flex", alignItems:"baseline", gap:8}}>
              <img src="/kas-icon.png" alt="KAS" width={56} height={56} style={{borderRadius:"50%"}} />
              <span style={{fontSize:32, color:C.accent, fontWeight:700, ...mono}}>{liveKas !== null ? fmt(liveKas, 4) : "—"}</span>
              <span style={{fontSize:14, color:C.dim, ...mono}}>KAS</span>
              {balanceUsd !== null && <span style={{fontSize:14, color:C.dim, ...mono}}>≈ {fmtUsd(balanceUsd)}</span>}
            </div>
          </div>
          
          {/* Compact Stats Row */}
          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:12}}>
            <div style={{background:C.s2, borderRadius:6, padding:"8px 10px", border:`1px solid ${C.border}`}}>
              <div style={{fontSize:9, color:C.dim, ...mono}}>SPENDABLE</div>
              <div style={{fontSize:13, color:C.accent, fontWeight:600, ...mono}}>{liveKas !== null ? fmt(spendableKas, 2) : "—"} KAS</div>
            </div>
            <div style={{background:C.s2, borderRadius:6, padding:"8px 10px", border:`1px solid ${C.border}`}}>
              <div style={{fontSize:9, color:C.dim, ...mono}}>RESERVE</div>
              <div style={{fontSize:13, color:C.accent, fontWeight:600, ...mono}}>{RESERVE} KAS</div>
            </div>
            <div style={{background:C.s2, borderRadius:6, padding:"8px 10px", border:`1px solid ${C.border}`}}>
              <div style={{fontSize:9, color:C.dim, ...mono}}>PRICE</div>
              <div style={{fontSize:13, color:C.text, fontWeight:600, ...mono}}>{priceUsd > 0 ? `$${priceUsd.toFixed(4)}` : "—"}</div>
            </div>
          </div>
        </div>
        
        {err && <div style={{padding:"8px 16px", background:`${C.danger}15`, fontSize:11, color:C.danger, ...mono}}>⚠ {err}</div>}
      </Card>

      {/* SEND KAS */}
      <Card p={14} style={{marginBottom:10, background:C.s2, border:`1px solid ${C.border}`}}>
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10}}>
          <Label style={{marginBottom:0, fontSize:12}}>Send <img src="/kas-icon.png" alt="KAS" width={32} height={32} style={{borderRadius:"50%", verticalAlign:"middle"}} /></Label>
          <Badge text="OUTGOING" color={C.dim} />
        </div>
        
        {/* Quick buttons */}
        <div style={{display:"flex", gap:6, marginBottom:10}}>
          {[{l:"25%",v:maxSendKas*0.25},{l:"50%",v:maxSendKas*0.5},{l:"MAX",v:maxSendKas}].map(p => (
            <button key={p.l} onClick={()=>setWithdrawAmt(p.v.toFixed(4))} disabled={maxSendKas<=0}
              style={{flex:1, padding:"6px", borderRadius:4, border:`1px solid ${C.border}`, background:C.s1, color:C.dim, fontSize:10, cursor:"pointer", ...mono}}>
              {p.l}
            </button>
          ))}
        </div>
        
        <Inp label="Recipient" value={withdrawTo} onChange={setWithdrawTo} placeholder="kaspa:..." />
        <div style={{display:"grid", gridTemplateColumns:"1fr auto", gap:6, alignItems:"end", marginBottom:8}}>
          <Inp label="Amount" value={withdrawAmt} onChange={setWithdrawAmt} type="number" suffix="KAS" placeholder="0" />
          <Btn onClick={()=>setWithdrawAmt(maxSend)} variant="ghost" size="sm">MAX</Btn>
        </div>
        
        <Btn onClick={initiateWithdraw} disabled={!isKaspaAddress(withdrawTo, ALLOWED_ADDRESS_PREFIXES) || !Number(withdrawAmt) || Number(withdrawAmt) > maxSendKas}
          style={{width:"100%", padding:"8px", fontSize:11}}>
          ↗ SEND {withdrawAmt || "0"} KAS
        </Btn>
      </Card>

      {/* RECEIVE KAS */}
      <Card p={14} style={{marginBottom:10, background:C.s2, border:`1px solid ${C.border}`}}>
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10}}>
          <Label style={{marginBottom:0, fontSize:12}}>Receive <img src="/kas-icon.png" alt="KAS" width={32} height={32} style={{borderRadius:"50%", verticalAlign:"middle"}} /></Label>
          <Badge text="INCOMING" color={C.dim} />
        </div>
        
        <div style={{display:"flex", gap:6}}>
          <div style={{flex:1, background:C.s1, borderRadius:4, padding:"8px 10px", border:`1px solid ${C.border}`, overflow:"hidden"}}>
            <div style={{fontSize:9, color:C.dim, ...mono, marginBottom:2}}>DEPOSIT ADDRESS</div>
            <div style={{fontSize:9, color:C.accent, ...mono, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
              {wallet?.address || "—"}
            </div>
          </div>
          <Btn onClick={()=>navigator.clipboard?.writeText(wallet?.address || "")} variant="primary" style={{padding:"8px 12px", fontSize:11}}>📋</Btn>
        </div>
      </Card>

      {/* UTXOs */}
      {utxos.length > 0 && (
        <Card p={12}>
          <div style={{fontSize:10, color:C.dim, ...mono, marginBottom:8}}>UTXOs — {utxos.length}</div>
          {utxos.slice(0,5).map((u: any, i: number) => (
            <div key={i} style={{display:"flex", justifyContent:"space-between", padding:"6px 0", borderBottom:i<4?`1px solid ${C.border}`:"none", fontSize:10, ...mono}}>
              <span style={{color:C.dim, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:"60%"}}>{u.outpoint?.transactionId?.slice(0,24)}...</span>
              <span style={{color:C.accent}}>{fmt((u.utxoEntry?.amount||0)/1e8,2)} KAS</span>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

