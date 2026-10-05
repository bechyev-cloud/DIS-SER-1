'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('training preference: student tasks, trainer entry, per-account persistence and unchanged permissions',()=>{
 const html=fs.readFileSync(path.resolve(__dirname,'../../user-pwa/index.html'),'utf8');
 const code=html.slice(html.indexOf('  function trainingPreferenceKey()'),html.indexOf('  function pluralGroups'));
 const store=new Map(),elements=new Map(),navigation=[{style:{}},{style:{}}];let change,loads=0;
 const el=id=>{if(!elements.has(id))elements.set(id,{textContent:'',innerHTML:'',addEventListener:(event,fn)=>{change=fn;}});return elements.get(id);};
 const c={localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)},currentUser:{id:3,role:'USER'},currentView:'settings',window:{DPConnection:{settings:{systemId:'same-system'}}},document:{getElementById:el,querySelector:el,querySelectorAll:()=>navigation},state:{habits:[{id:'one',name:'Personal'},{id:'two',name:'From coach',assignedBy:7,createdAt:'2026-10-03'}]},renderShell(){},syncCalendarChoice(){},isLoggedIn:()=>!!c.currentUser,reloadTrainerDashboard:()=>loads++,todayKey:()=> '2026-10-03',renderHabitRowsForDate:()=>'<div>Scheduled today</div>',escapeHtml:s=>String(s),habitDisplayEmoji:()=> '✓'};
 vm.createContext(c);vm.runInContext(code,c);c.renderTrainerNavVisibility();assert.equal(c.trainingMode(),'student');assert.ok(navigation.every(n=>n.style.display===''));
 c.renderTrainingView();assert.match(el('trainer-body').innerHTML,/From coach/);assert.doesNotMatch(el('trainer-body').innerHTML,/Personal/);
 change({target:{checked:true}});assert.equal(c.trainingMode(),'trainer');assert.equal(el('training-role-label').textContent,'Тренер');c.renderTrainingView();assert.match(el('trainer-body').innerHTML,/Тарифы для тренера/);assert.equal(loads,0);assert.equal(c.currentUser.role,'USER');
 c.currentUser={id:4,role:'TRAINER'};assert.equal(c.trainingMode(),'trainer');c.renderTrainingView();assert.equal(loads,1);change({target:{checked:false}});assert.equal(c.trainingMode(),'student');c.currentUser={id:3,role:'USER'};assert.equal(c.trainingMode(),'trainer');
 c.currentUser=null;c.renderTrainingView();assert.match(el('trainer-body').innerHTML,/Войти в аккаунт/);
});
