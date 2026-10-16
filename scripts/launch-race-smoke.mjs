// Isolated Chrome event delivery, with a gated API response instead of touching
// ordinary tabs or waiting 30 real seconds. Supports the unmodified old release.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {startFixtureSites} from '../tests/fixtures/browser-sites.mjs';
const root=resolve(import.meta.dirname,'..'),extension=resolve(root,process.env.EXTENSION_DIR||'extension');
const output=join(root,'output/playwright','launch-race-'+Date.now());await mkdir(output,{recursive:true});
const profile=await mkdtemp(join(output,'profile-')),sites=await startFixtureSites();
const baseline=process.env.EXPECT_BASELINE_RACE==='1',results=[];let context;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const end=Date.now()+15000;while(Date.now()<end){if(await check())return;await pause(40);}throw new Error('Timed out waiting for fixture gate');}
try{
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--no-proxy-server','--host-resolver-rules=MAP *.localhost 127.0.0.1']});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),id=new URL(worker.url()).host,control=await context.newPage();
  await control.goto(`chrome-extension://${id}/options.html`);
  const message=(type,args={})=>control.evaluate(payload=>chrome.runtime.sendMessage(payload),{type,...args});
  assert.equal((await message('addUrl',{url:sites.app+'/app',label:'Fixture mail'})).ok,true);
  await message('close');
  async function gate(){await worker.evaluate(()=>{const group=chrome.tabs.group;globalThis.__waiting=false;chrome.tabs.group=async(...args)=>{chrome.tabs.group=group;globalThis.__waiting=true;await new Promise(resolve=>{globalThis.__release=resolve;});return group(...args);};});}
  for(const mode of ['user-navigation-and-repeated-click','expired-30-second-intent']){
    await gate();
    const pending=message('launch');await until(()=>worker.evaluate(()=>globalThis.__waiting));
    let repeated;
    const working=await context.newPage();await working.goto(sites.outside+'/working');await working.bringToFront();await working.locator('#note').fill('Unsaved working text');
    if(mode==='user-navigation-and-repeated-click'){
      repeated=message('launch');
      // The newer click also becomes stale when the user resumes their page.
      await working.bringToFront();await working.goto(sites.outside+'/working-next');await working.locator('#note').fill('Unsaved working text');
    }else await worker.evaluate(()=>{const now=Date.now.bind(Date);Date.now=()=>now()+30001;});
    const workingId=await control.evaluate(url=>chrome.tabs.query({}).then(tabs=>tabs.find(t=>t.url===url).id),working.url());
    await worker.evaluate(()=>globalThis.__release());
    assert.equal((await pending).ok,true);if(repeated)assert.equal((await repeated).ok,true);
    const current=await message('getState');
    const focused=await control.evaluate(()=>chrome.tabs.query({active:true,lastFocusedWindow:true}).then(tabs=>tabs[0]?.id));
    const staleFocus=focused!==workingId;
    assert.equal(staleFocus,baseline,`${mode}: ${baseline?'old release must reproduce delayed focus':'working tab must retain focus'}`);
    assert.equal(working.url(),sites.outside+(mode==='user-navigation-and-repeated-click'?'/working-next':'/working'));
    assert.equal(await working.locator('#note').inputValue(),'Unsaved working text');
    assert.equal(current.entries.length,1);assert.equal(Object.values(current.slots).length,1);
    results.push({mode,staleFocus,urlPreserved:true,unsavedInputPreserved:true,noDuplicateSlots:true});
    await message('close');await working.close();
  }
  const receipt={passed:true,baseline,results,ordinaryProfileAccess:false,fixtureSitesOnly:true};
  await writeFile(join(output,'result.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));console.log(output);
}finally{await context?.close();await sites.close();}
