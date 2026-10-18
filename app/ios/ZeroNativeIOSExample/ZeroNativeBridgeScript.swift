import Foundation

enum ZeroNativeBridgeScript {
    static let source = """
    (function(){
      if(window.zero&&window.zero.invoke){return;}
      var pending=new Map();
      var nextId=1;
      function post(message){
        if(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.zeroNativeBridge){
          window.webkit.messageHandlers.zeroNativeBridge.postMessage(message);
          return;
        }
        throw new Error('zero-native bridge transport is unavailable');
      }
      function complete(response){
        var id=response&&response.id!=null?String(response.id):'';
        var entry=pending.get(id);
        if(!entry){return;}
        pending.delete(id);
        if(response.ok){entry.resolve(response.result===undefined?null:response.result);return;}
        var errorInfo=response.error||{};
        var error=new Error(errorInfo.message||'Native command failed');
        error.code=errorInfo.code||'internal_error';
        entry.reject(error);
      }
      function invoke(command,payload){
        if(typeof command!=='string'||command.length===0){
          return Promise.reject(new TypeError('command must be a non-empty string'));
        }
        var id=String(nextId++);
        var envelope=JSON.stringify({id:id,command:command,payload:payload===undefined?null:payload});
        return new Promise(function(resolve,reject){
          pending.set(id,{resolve:resolve,reject:reject});
          try{post(envelope);}catch(error){pending.delete(id);reject(error);}
        });
      }
      Object.defineProperty(window,'zero',{
        value:Object.freeze({invoke:invoke,_complete:complete}),
        configurable:false
      });
    })();
    """
}
