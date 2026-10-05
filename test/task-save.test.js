const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../../user-pwa/index.html'),'utf8');
test('new and edited tasks save despite form name/target properties',()=>{
 const start=html.indexOf("    document.getElementById('habit-form').addEventListener('submit'");
 const source=html.slice(start,html.indexOf('  /* ---------- toast',start)).trim().replace(/\n  }$/,'');
 for(const type of ['simple','assignment','workout','timer','checklist','zikr'])for(const existing of [null,{id:'old',config:{}}]){
  let submit,saved,closed=false;const fields={name:'Новая задача',workSec:'30',restSec:'10',rounds:'4',perTap:'1',target:'100',endDate:'',endCount:'10',time:'',defaultDuration:'20'};
  const form={name:'',target:'_self',elements:{namedItem:n=>({value:fields[n]})},querySelector:()=>null};
  const goal={enabled:true,total:100,daily:10,repeat:'daily',mode:'percent',buttons:[{value:10,label:'1'},{value:20,label:'2'},{value:50,label:'3'}]};
  const c={document:{getElementById:()=>({addEventListener:(n,f)=>submit=f})},existing,type,selectedEmoji:'🎯',selectedRepeat:'daily',selectedEnd:'none',selectedWorkoutType:'strength',readGoal:()=>goal,readAssignmentButtons:()=>[{amount:10}],readZikrRows:()=>[{label:'Зикр',target:33}],readChecklistRows:()=>[{text:'Пункт'}],MODE_ORDER:[],isModeEnabledForNewTasks:()=>true,uid:()=> 'item',addHabit:(...args)=>saved=args,updateHabit:(...args)=>saved=args,closeModal:()=>closed=true,showToast(){}};
  vm.createContext(c);vm.runInContext(source,c);submit({preventDefault(){},target:form});assert.ok(closed);assert.ok(saved);assert.equal(saved[saved.length-1].goal,goal);assert.equal(saved[existing?1:0],'Новая задача');
 }
});

test('date range supports past/future starts and includes final day',()=>{const c={};vm.createContext(c);vm.runInContext(html.slice(html.indexOf('  function taskStart('),html.indexOf('  function habitsActiveOn(')),c);const h={createdAt:'2026-10-03',config:{schedule:{start:'2026-10-01',end:'2026-10-15'}}};assert.equal(c.taskInDateRange(h,'2026-09-30'),false);assert.equal(c.taskInDateRange(h,'2026-10-01'),true);assert.equal(c.taskInDateRange(h,'2026-10-15'),true);assert.equal(c.taskInDateRange(h,'2026-10-16'),false);h.config.schedule={start:null,end:null};assert.equal(c.taskInDateRange(h,'2026-10-03'),true);assert.equal(c.taskInDateRange(h,'2027-01-01'),true);});
