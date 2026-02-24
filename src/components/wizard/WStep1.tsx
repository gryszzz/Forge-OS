import { useState } from "react";
import { C, mono } from "../../tokens";
import { shortAddr } from "../../helpers";
import { Badge, Inp, Label, Card, Btn } from "../ui";
import { RISK_OPTS, STRATEGY_TEMPLATES, PROFESSIONAL_PRESETS } from "./constants";

export const WStep1 = ({d, set, wallet}: any) => {
  const [showCustomModal, setShowCustomModal] = useState(false);
  const [customName, setCustomName] = useState("");
  
  const handlePresetSelect = (preset: any) => {
    set("strategyTemplate", preset.id);
    set("strategyLabel", preset.name);
    set("strategyClass", preset.class);
    Object.entries(preset.defaults).forEach(([k, v]) => set(k, v));
  };
  
  const handleCustomSave = () => {
    if (customName.trim()) {
      set("strategyLabel", customName.trim());
      set("strategyTemplate", "custom");
      set("strategyClass", "custom");
    }
    setShowCustomModal(false);
    setCustomName("");
  };

  return (
  <div>
    <div style={{fontSize:17, color:C.text, fontWeight:700, marginBottom:3, ...mono}}>Configure Agent</div>
    <div style={{fontSize:12, color:C.dim, marginBottom:20}}>Connected: <span style={{color:C.accent, ...mono}}>{shortAddr(wallet?.address)}</span></div>
    <Label>Strategy Profile (Self-Trading Bot, Accumulation-First)</Label>
    <div style={{display:"grid", gridTemplateColumns:"repeat(2,1fr)", gap:10, marginBottom:16}}>
      {STRATEGY_TEMPLATES.map((tpl) => {
        const on = d.strategyTemplate === tpl.id;
        return (
          <div
            key={tpl.id}
            onClick={() => {
              set("strategyTemplate", tpl.id);
              set("strategyLabel", tpl.name);
              set("strategyClass", tpl.class);
              Object.entries(tpl.defaults).forEach(([k, v]) => set(k, v));
            }}
            style={{
              padding:"16px 18px",
              borderRadius:10,
              cursor:"pointer",
              border:`2px solid ${on ? C.accent : C.border}`,
              background:on ? `${C.accent}15` : C.s2,
              transition:"all 0.2s",
              boxShadow: on ? `0 4px 12px ${C.accent}30` : "none"
            }}
          >
            <div style={{display:"flex", justifyContent:"space-between", gap:8, alignItems:"center", marginBottom:8}}>
              <div style={{fontSize:14, color:on?C.accent:C.text, fontWeight:700, ...mono}}>{tpl.name}</div>
              <Badge text={tpl.tag} color={tpl.tagColor || C.ok}/>
            </div>
            <div style={{fontSize:11, color:C.text, marginBottom:3}}>{tpl.purpose || tpl.desc}</div>
            {tpl.bestFor && <div style={{fontSize:10, color:C.dim}}>Best for: {tpl.bestFor}</div>}
            {tpl.desc && tpl.purpose && <div style={{fontSize:10, color:C.dim, marginTop:3}}>{tpl.desc}</div>}
          </div>
        );
      })}
    </div>
    
    {/* Professional Presets Section */}
    <div style={{marginTop:20, marginBottom:12}}>
      <div style={{fontSize:11, color:C.dim, letterSpacing:"0.08em", ...mono, marginBottom:8}}>PROFESSIONAL PRESETS</div>
    </div>
    <div style={{display:"grid", gridTemplateColumns:"repeat(2,1fr)", gap:10, marginBottom:12}}>
      {PROFESSIONAL_PRESETS.map((preset) => {
        const on = d.strategyTemplate === preset.id;
        return (
          <div
            key={preset.id}
            onClick={() => {
              if (preset.id === "custom") {
                setShowCustomModal(true);
              } else {
                handlePresetSelect(preset);
              }
            }}
            style={{
              padding:"12px 14px",
              borderRadius:8,
              cursor:"pointer",
              border:`1px solid ${on ? C.accent : C.border}`,
              background:on ? C.aLow : C.s2,
              transition:"all 0.15s",
            }}
          >
            <div style={{display:"flex", justifyContent:"space-between", gap:8, alignItems:"center", marginBottom:4}}>
              <div style={{fontSize:12, color:on?C.accent:C.text, fontWeight:700, ...mono}}>{preset.name}</div>
              <Badge text={preset.tag} color={preset.tagColor || C.purple}/>
            </div>
            <div style={{fontSize:10, color:C.dim, lineHeight:1.4}}>{preset.purpose}</div>
            {preset.id !== "custom" && (
              <div style={{fontSize:10, color:C.dim, marginTop:4, display:"flex", gap:6}}>
                <span>Risk: {preset.defaults.risk}</span>
                <span>•</span>
                <span>Target: {preset.defaults.kpiTarget}%</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
    
    <Inp label="Agent Name" value={d.name} onChange={(v: string)=>set("name", v)} placeholder="KAS-Alpha-01"/>
    <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:12}}>
      <Inp label="ROI Target" value={d.kpiTarget} onChange={(v: string)=>set("kpiTarget", v)} type="number" placeholder="12" suffix="%"/>
      <Inp label="Capital / Cycle" value={d.capitalLimit} onChange={(v: string)=>set("capitalLimit", v)} type="number" placeholder="5000" suffix="KAS"/>
    </div>
    <Label>Risk Tolerance</Label>
    <div style={{display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8}}>
      {RISK_OPTS.map(r=>{const on = d.risk === r.v; return (
        <div key={r.v} onClick={()=>set("risk", r.v)} style={{padding:"12px 10px", borderRadius:4, cursor:"pointer", border:`1px solid ${on?C.accent:C.border}`, background:on?C.aLow:C.s2, textAlign:"center", transition:"all 0.15s"}}>
          <div style={{fontSize:13, color:on?C.accent:C.text, fontWeight:700, ...mono, marginBottom:3}}>{r.l}</div>
          <div style={{fontSize:11, color:C.dim}}>{r.desc}</div>
        </div>
      );})}
    </div>
    
    {/* Custom Preset Modal */}
    {showCustomModal && (
      <div style={{position:"fixed", inset:0, background:"rgba(0,0,0,0.8)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:20}}>
        <Card p={24} style={{maxWidth:420, width:"100%"}}>
          <div style={{fontSize:16, color:C.text, fontWeight:700, ...mono, marginBottom:16}}>Custom Preset Configuration</div>
          <div style={{fontSize:12, color:C.dim, marginBottom:16}}>
            Configure your own professional strategy with custom parameters.
          </div>
          <Inp label="Custom Preset Name" value={customName} onChange={setCustomName} placeholder="My Custom Strategy" />
          <div style={{marginTop:16, marginBottom:8, fontSize:12, color:C.accent, ...mono}}>Quick Parameters</div>
          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:16}}>
            <Inp label="ROI Target" value={d.kpiTarget} onChange={(v: string)=>set("kpiTarget", v)} type="number" placeholder="12" suffix="%"/>
            <Inp label="Capital / Cycle" value={d.capitalLimit} onChange={(v: string)=>set("capitalLimit", v)} type="number" placeholder="5000" suffix="KAS"/>
          </div>
          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:16}}>
            <Inp label="Horizon (days)" value={d.horizon} onChange={(v: string)=>set("horizon", v)} type="number" placeholder="30"/>
            <Inp label="Auto-Approve ≤" value={d.autoApproveThreshold} onChange={(v: string)=>set("autoApproveThreshold", v)} type="number" placeholder="50" suffix="KAS"/>
          </div>
          <Label>Risk Tolerance</Label>
          <div style={{display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, marginBottom:16}}>
            {RISK_OPTS.map(r=>{const on = d.risk === r.v; return (
              <div key={r.v} onClick={()=>set("risk", r.v)} style={{padding:"10px 8px", borderRadius:4, cursor:"pointer", border:`1px solid ${on?C.accent:C.border}`, background:on?C.aLow:C.s2, textAlign:"center", transition:"all 0.15s"}}>
                <div style={{fontSize:12, color:on?C.accent:C.text, fontWeight:700, ...mono}}>{r.l}</div>
              </div>
            );})}
          </div>
          <Label>Execution Mode</Label>
          <div style={{display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, marginBottom:16}}>
            {[{v:"autonomous",l:"Auto"},{v:"manual",l:"Manual"},{v:"notify",l:"Notify"}].map(r=>{const on = d.execMode === r.v; return (
              <div key={r.v} onClick={()=>set("execMode", r.v)} style={{padding:"10px 8px", borderRadius:4, cursor:"pointer", border:`1px solid ${on?C.accent:C.border}`, background:on?C.aLow:C.s2, textAlign:"center", transition:"all 0.15s"}}>
                <div style={{fontSize:12, color:on?C.accent:C.text, fontWeight:700, ...mono}}>{r.l}</div>
              </div>
            );})}
          </div>
          <div style={{display:"flex", gap:10}}>
            <Btn onClick={()=>setShowCustomModal(false)} variant="ghost" style={{flex:1}}>Cancel</Btn>
            <Btn onClick={handleCustomSave} style={{flex:1}}>Save Custom</Btn>
          </div>
        </Card>
      </div>
    )}
  </div>
  );
};
