export const SUCCESS_TEMPLATE_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Authentication Successful</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 40px; text-align: center; background-color: #f0f2f5; color: #333; display: flex; justify-content: center; align-items: center; height: 90vh; }
        .container { background-color: #ffffff; padding: 40px; border-radius: 8px; box-shadow: 0 6px 12px rgba(0,0,0,0.15); display: inline-block; max-width: 500px; }
        h1 { color: #2c8c2c; font-size: 1.8em; margin-bottom: 20px; }
        p { font-size: 1.1em; line-height: 1.6; }
        .close-message { margin-top: 30px; font-size: 0.95em; color: #555; }
        .icon { font-size: 3em; color: #2c8c2c; margin-bottom: 15px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">✓</div>
        <h1>Authentication Successful!</h1>
        <p>You have successfully signed in to the Dynamics 365 Web Resource Manager extension.</p>
        <p class="close-message">You can now close this browser window and return to VS Code.</p>
    </div>
</body>
</html>
`;

export const ERROR_TEMPLATE_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Authentication Failed</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 40px; text-align: center; background-color: #f0f2f5; color: #333; display: flex; justify-content: center; align-items: center; height: 90vh; }
        .container { background-color: #ffffff; padding: 40px; border-radius: 8px; box-shadow: 0 6px 12px rgba(0,0,0,0.15); display: inline-block; max-width: 500px; }
        h1 { color: #d93025; font-size: 1.8em; margin-bottom: 20px; }
        p { font-size: 1.1em; line-height: 1.6; }
        .error-details { margin-top: 20px; font-size: 0.95em; color: #555; }
        .close-message { margin-top: 30px; font-size: 0.95em; color: #555; }
        .icon { font-size: 3em; color: #d93025; margin-bottom: 15px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">✕</div>
        <h1>Authentication Failed</h1>
        <p>Oops! Something went wrong during the authentication process.</p>
        <p class="error-details">Please try again. If the problem persists, check the VS Code extension output channel (Web Resource Manager) for more details or contact your administrator.</p>
        <p class="close-message">You can close this browser window.</p>
    </div>
</body>
</html>
`;
