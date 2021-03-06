/*
 * This is a basic func test for a Common application.
 */
YUI({
    useConsoleOutput: true,
    useBrowserConsole: true,
    logInclude: { TestRunner: true }
}).use('node', 'node-event-simulate', 'test', 'console', function (Y) {
   
    var suite = new Y.Test.Suite("Common: postparamssimpleclient");

    suite.add(new Y.Test.Case({

        "test postparamssimpleclient": function() {
            var that = this;
            Y.one('#postParamsSimpleButton').simulate('click');
            that.wait(function(){
	            Y.Assert.areEqual('Input Parameters Testing', Y.one('#iptitle').get('innerHTML').match(/Input Parameters Testing/gi));
	            Y.Assert.areEqual('POST Parameters', Y.one('#pptitle').get('innerHTML').match(/POST Parameters/gi));
	            Y.Assert.areEqual('Here\'s the POST data!', Y.one('#desc').get('innerHTML').match(/Here\'s the POST data!/gi));
	            Y.Assert.areEqual('Nobody likes spinach!', Y.one('#ouput').get('innerHTML').match(/Nobody likes spinach!/gi));        
            }, 4000);
        }

    }));

    Y.Test.Runner.add(suite);
});