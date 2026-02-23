import { DEFAULT_NETWORK } from "../../constants";
import { shortAddr } from "../../helpers";
import { C, mono } from "../../tokens";
import { Btn, Card } from "../ui";
import { STRATEGY_TEMPLATES } from "./constants";

export const WStep3 = ({d, wallet, onDeploy}: any) => {
  const canDeploy = d.name && d.capitalLimit && d.kpiTarget;
  const strategyMeta = STRATEGY_TEMPLATES.find((tpl) => tpl.id === d.strategyTemplate);
  return(
    <div>
      <div style={{fontSize:17, color:C.text, fontWeight:700, marginBottom:3, ...mono}}>Review & Deploy</div>
      <div style={{fontSize:12, color:C.dim, marginBottom:18}}>Agent vault will be provisioned. Initial funding requires a wallet signature.</div>
      <Card p={0} style={{marginBottom:14}}>
        {[["Agent", d.name || "—"], ["Strategy Template", d.strategyLabel || d.strategyTemplate || "Custom"], ["Wallet", shortAddr(wallet?.address)], ["Network", wallet?.network || DEFAULT_NETWORK], ["ROI Target", `${d.kpiTarget}%`], ["Capital / Cycle", `${d.capitalLimit} KAS`], ["Portfolio Allocator", "AUTO"], ["Risk", d.risk.toUpperCase()], ["Exec Mode", d.execMode.replace(/_/g, " ").toUpperCase()], ["Signing", "WALLET-NATIVE GUARDRAILS"]].map(([k,v],i,a)=>(
          <div key={k as any} style={{display:"flex", justifyContent:"space-between", padding:"9px 16px", borderBottom:i<a.length-1?`1px solid ${C.border}`:"none"}}>
            <span style={{fontSize:12, color:C.dim, ...mono}}>{k}</span>
            <span style={{fontSize:12, color:C.text, ...mono}}>{v}</span>
          </div>
        ))}
      </Card>
      <Btn onClick={onDeploy} disabled={!canDeploy} style={{width:"100%", padding:"11px 0"}}>DEPLOY AGENT — SIGN WITH WALLET</Btn>
      {!canDeploy && <div style={{fontSize:11, color:C.warn, marginTop:6, textAlign:"center", ...mono}}>Name, capital, and target required.</div>}
    </div>
  );
};

