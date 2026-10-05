const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
for(const app of ['user-pwa','admin-pwa'])test(app+': drag and swipe do not dismiss dialogs; backdrop taps do',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../..',app,'index.html'),'utf8'),listeners={};let closed=0;
 const overlay={addEventListener:(n,f)=>listeners[n]=f},inside={};
 const c={overlay,document:{addEventListener:(n,f)=>listeners[n]=f},window:{addEventListener:(n,f)=>listeners[n]=f},closeModal:()=>closed++,Math};
 vm.createContext(c);const start=html.indexOf('  var backdropPress=');const end=html.indexOf("  overlay.addEventListener('click',function(e)",start);vm.runInContext(html.slice(start,html.indexOf('\n',end)),c);
 const event=(target,x=100)=>({target,clientX:x,clientY:50,pointerId:1,button:0,isPrimary:true});
 listeners.pointerdown(event(inside));listeners.pointerup(event(overlay,20));listeners.click(event(overlay));assert.equal(closed,0);
 listeners.pointerdown(event(overlay));listeners.pointermove(event(overlay,20));listeners.pointerup(event(overlay));listeners.click(event(overlay));assert.equal(closed,0);
 listeners.pointerdown(event(overlay));listeners.pointercancel();listeners.pointerup(event(overlay));listeners.click(event(overlay));assert.equal(closed,0);
 listeners.pointerdown(event(overlay));listeners.pointerup(event(inside));listeners.click(event(overlay));assert.equal(closed,0);
 listeners.pointerdown(event(overlay));listeners.pointerup(event(overlay,102));listeners.click(event(overlay));assert.equal(closed,1);
 listeners.click(event(overlay));assert.equal(closed,1);
});
