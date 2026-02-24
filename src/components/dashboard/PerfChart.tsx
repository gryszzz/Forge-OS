import { useEffect, useRef, useState } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { clamp, fmtD } from "../../helpers";
import { C, mono } from "../../tokens";
import { Badge, Card, Label } from "../ui";

const ChartTip = ({active, payload}: any) => {
  if(!active || !payload?.length) return null;
  const pt = payload[0]?.payload;
  return(
    <div style={{background:C.s2, border:`1px solid ${C.border}`, borderRadius:4, padding:"8px 12px"}}>
      <div style={{fontSize:10, color:C.dim, ...mono, marginBottom:3}}>{pt?.label}</div>
      <div style={{fontSize:13, color:pt?.roi>=0?C.ok:C.danger, fontWeight:700, ...mono}}>{pt?.roi>=0?"+":""}{pt?.roi}%</div>
    </div>
  );
};

export function PerfChart({decisions, kpiTarget}: any) {
  const [pts, setPts] = useState(()=>{
    const now = Date.now(); let roi = 0;
    return Array.from({length:16},(_,i)=>{roi=clamp(roi+(Math.random()-0.42)*1.4,-15,30);return{label:fmtD(now-(15-i)*3600000*2),roi:parseFloat(roi.toFixed(2)),target:Number(kpiTarget)||12};});
  });
  const prevLen = useRef(0);
  useEffect(()=>{
    if(decisions.length<=prevLen.current) return;
    prevLen.current = decisions.length;
    const dec = decisions[0]?.dec;
    const last = pts[pts.length-1];
    const d = dec?.action==="ACCUMULATE"?Math.random()*1.2:dec?.action==="REDUCE"?-Math.random()*0.8:(Math.random()-0.5)*0.4;
    setPts(p=>[...p.slice(-40),{label:fmtD(Date.now()),roi:parseFloat((last.roi+d).toFixed(2)),target:Number(kpiTarget)||12}]);
  },[decisions.length]);
  const latest = pts[pts.length-1];
  const tgt = Number(kpiTarget)||12;
  const prog = clamp((latest.roi/tgt)*100,0,100).toFixed(0);
  return(
    <Card p={18}>
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10}}>
        <div>
          <Label>Performance — Agent ROI</Label>
          <span style={{fontSize:24, color:latest.roi>=0?C.ok:C.danger, fontWeight:700, ...mono}}>{latest.roi>=0?"+":""}{latest.roi}%</span>
          <span style={{fontSize:12, color:C.dim, marginLeft:10}}>target {tgt}%</span>
        </div>
        <Badge text={latest.roi>=tgt?"TARGET MET":"IN PROGRESS"} color={latest.roi>=tgt?C.ok:C.warn}/>
      </div>
      <div style={{height:3, background:C.s2, borderRadius:2, marginBottom:14}}>
        <div style={{height:"100%", width:`${prog}%`, background:latest.roi>=tgt?C.ok:C.accent, borderRadius:2, transition:"width 0.5s"}}/>
      </div>
      <ResponsiveContainer width="100%" height={160}>
        <AreaChart data={pts} margin={{top:2, right:4, left:-24, bottom:0}}>
          <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.accent} stopOpacity={0.14}/><stop offset="95%" stopColor={C.accent} stopOpacity={0}/></linearGradient></defs>
          <CartesianGrid stroke={C.border} strokeDasharray="3 3" vertical={false}/>
          <XAxis dataKey="label" tick={{fill:C.dim, fontSize:10, fontFamily:"Courier New"}} tickLine={false} axisLine={false} interval={4}/>
          <YAxis tick={{fill:C.dim, fontSize:10, fontFamily:"Courier New"}} tickLine={false} axisLine={false} tickFormatter={v=>`${v}%`}/>
          <Tooltip content={<ChartTip/>}/>
          <ReferenceLine y={tgt} stroke={C.warn} strokeDasharray="5 4" strokeWidth={1}/>
          <ReferenceLine y={0}   stroke={C.muted} strokeWidth={1}/>
          <Area type="monotone" dataKey="roi" stroke={C.accent} strokeWidth={2} fill="url(#g)" dot={false}/>
        </AreaChart>
      </ResponsiveContainer>
    </Card>
  );
}
